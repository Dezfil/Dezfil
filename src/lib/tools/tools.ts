import { compoundRevisionPath, withoutCompoundRevision } from "./compound-revisions";
import { projectOutput, type OutputOperation, type OutputAdaptation } from "./output-schema";
import type { JsonSchema } from "./schema";
import type { McpConsequences } from "@/lib/api/operation-mcp";
import type { AssistantPage, ConfirmationWords, OperationDisplay, OperationEffects } from "@/lib/api/operation-metadata";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import { projectInput, type InputOperation, type InputSchema } from "./input-schema";

/**
 * The agent tool layer (one tool set, derived from the machine-readable
 * API description, consumed by both the MCP endpoint and the in-product
 * assistant — tools and API documentation never diverge).
 *
 * Every documented operation becomes exactly one tool, named by its
 * `x-tool` extension in the OpenAPI document. Input schemas are the
 * operation's path parameters plus its (ref-resolved, self-contained)
 * request-body schema, flattened into one object for agent friendliness.
 */

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: InputSchema;
  providerInputSchema?: InputSchema;
  compoundRevisionPath?: "members" | "self";
  outputSchema?: InputSchema;
  rawOutputSchema?: JsonSchema;
  outputAdaptation?: OutputAdaptation;
  headerParams?: { name: string; argument: string }[];
  bodyRequired?: boolean;
  bodyContent?: "json" | "multipart";
  multipart?: { field: string; filename: string; content: string };
  /** Lowercase HTTP method of the underlying documented operation. */
  method: string;
  /** Templated API path of the underlying documented operation. */
  path: string;
  /** The assistant must obtain explicit user confirmation before calling. */
  confirm: boolean;
  effects: OperationEffects;
  mcp?: McpConsequences;
  confirmation?: ConfirmationWords;
  /** The record's words for a call. */
  display: OperationDisplay;
  /** The pages whose default offer holds this operation. */
  relevance: AssistantPage[];
  /** Confirmation depends on the call's blast radius; the operation's own
   * plan says which case this one is. */
  confirmWhen?: "when_wide";
  /** Multipart upload: args are `filename` + `content_base64`. */
  upload: boolean;
  /** Argument names that belong in the JSON request body. */
  bodyKeys: string[];
  /** Argument names that fill path template parameters. */
  pathParams: string[];
  /** Argument names that travel as query parameters (spec a
   * documented query input a tool dropped made `search_map` unusable). */
  queryParams: string[];
}

interface Operation extends InputOperation, OutputOperation {
  summary?: string;
  description?: string;
  "x-tool"?: string | false;
  "x-confirm"?: boolean | "when_wide";
  "x-effects": OperationEffects;
  "x-mcp"?: McpConsequences;
  "x-confirmation"?: ConfirmationWords;
  "x-display"?: OperationDisplay;
  "x-relevance"?: readonly AssistantPage[];
  tags?: string[];

}

const HTTP_METHODS = ["get", "post", "patch", "put", "delete"];

/** The derivation is pure over a static document — build once per process.
 * The MCP handler builds a fresh server per request (stateless), so without
 * this the whole document would be re-derived on every call. */
let cachedTools: ToolDef[] | null = null;

export function buildTools(): ToolDef[] {
  cachedTools ??= deriveTools(buildOpenApiDocument());
  return cachedTools;
}

/** The pages an operation's tag places it on when it declares no
 * relevance of its own: map and layer work on the builder, workflow work
 * on the canvas, SQL everywhere; anything else is reachable through
 * discovery rather than offered. */
const TAG_RELEVANCE: Record<string, readonly AssistantPage[]> = {
  Maps: ["builder"], Layers: ["builder"], Publish: ["builder"],
  Query: ["builder", "sql", "workflow"],
  Recipes: ["workflow"],
};

/** Exported for the parity suite, which derives over seeded documents
 * a missing declaration and a wrong one must each fail. */
export function deriveTools(doc: ReturnType<typeof buildOpenApiDocument>): ToolDef[] {
  const schemas = doc.components.schemas as unknown as Record<string, unknown>;
  const tools: ToolDef[] = [];

  for (const [apiPath, methods] of Object.entries(doc.paths)) {
    for (const method of HTTP_METHODS) {
      const op = (methods as Record<string, unknown>)[method] as
        | Operation
        | undefined;
      if (!op) continue;
      const name = op["x-tool"];
      // `x-tool: false` is a deliberate, test-enforced exclusion (e.g. the
      // MCP endpoint itself); a missing name is always an authoring error.
      if (name === false) continue;
      if (!name) {
        throw new Error(`Operation ${method.toUpperCase()} ${apiPath} has no x-tool name`);
      }
      // The record's words are declared, never derived from the path: a
      // missing declaration fails here, not at render.
      const display = op["x-display"];
      if (!display || typeof display.verb !== "string" || !display.verb.trim()) {
        throw new Error(`Tool ${name} (${method.toUpperCase()} ${apiPath}) has no x-display declaration`);
      }
      const relevance = [...(op["x-relevance"] ?? TAG_RELEVANCE[op.tags?.[0] ?? ""] ?? [])];

      let input: ReturnType<typeof projectInput>;
      try { input = projectInput(op, schemas, name); }
      catch (error) { throw new Error(`Tool ${name} (${method.toUpperCase()} ${apiPath}) input: ${error instanceof Error ? error.message : "Invalid declaration"}`); }

      const mcp = op["x-mcp"];
      if (!mcp || typeof mcp.destructiveHint !== "boolean" || typeof mcp.openWorldHint !== "boolean" ||
          (mcp.idempotentHint === undefined ? !mcp.repeatability?.trim() : typeof mcp.idempotentHint !== "boolean")) {
        throw new Error(`Tool ${name} (${method.toUpperCase()} ${apiPath}) has invalid or missing x-mcp declaration`);
      }
      const description = [op.summary, op.description].filter(Boolean).join(". ");

      const compoundPath = compoundRevisionPath(input.inputSchema);
      let providerInputSchema = input.headerParams.length
        ? projectInput({ ...op, parameters: op.parameters?.filter(parameter => parameter.in !== "header") }, schemas, name).inputSchema
        : undefined;
      if (compoundPath) providerInputSchema = withoutCompoundRevision(providerInputSchema ?? input.inputSchema, compoundPath);
      tools.push({
        name,
        description,
        ...input,
        ...projectOutput(op, schemas, name),
        ...(providerInputSchema ? { providerInputSchema } : {}),
        ...(compoundPath ? { compoundRevisionPath: compoundPath } : {}),
        method,
        path: apiPath,
        confirm: op["x-confirm"] === true,
        effects: op["x-effects"],
        mcp,
        display,
        relevance,
        ...(op["x-confirmation"] ? { confirmation: op["x-confirmation"] } : {}),
        // A conditional confirmation is not a boolean, and flattening it to
        // one would either over-prompt on the narrow case or under-prompt on
        // the wide one. The caller reads this and asks the operation's own
        // plan.
        ...(op["x-confirm"] === "when_wide"
          ? { confirmWhen: "when_wide" as const }
          : {}),
      });
    }
  }
  return tools;
}
