import type { OutputAdaptation } from "@/lib/tools/output-schema";
import type { McpConsequences } from "./operation-mcp";
import type { AssistantPage, ConfirmationWords, OperationDisplay, OperationEffects } from "./operation-metadata";

/** Shared operation envelopes; route-specific contracts stay in their modules. */
export const ERROR_RESPONSE = {
  description: "Error with a machine-readable code and human message.",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/Error" },
    },
  },
};

export function op(config: {
  summary: string;
  description?: string;
  tag: string;
  /** Curated agent-tool name for this operation (spec the tool set is
   * derived from this document and never diverges from it). `false` excludes
   * the operation from the tool set — deliberate, and test-enforced. */
  tool: string | false;
  /**
   * The assistant must obtain explicit user confirmation before calling
   * (destructive or exposure-changing operations). Advisory for MCP clients.
   *
   * `"when_wide"` is the case draws out: one control whose blast radius
   * depends on what it is aimed at. Re-running a step that carries dependents
   * is wide; the same request aimed at a step nothing reads carries only
   * itself and is not. The operation says which by answering its own plan
   * first, so a caller knows before it commits rather than after.
   */
  confirm?: boolean | "when_wide";
  effects: OperationEffects;
  mcp?: McpConsequences;
  toolOutput?: Omit<OutputAdaptation, "envelope">;
  confirmation?: ConfirmationWords;
  /** The record's words for a call. Required on every
   * operation that generates a tool; a tool-excluded operation needs none. */
  display?: OperationDisplay;
  /** The pages whose default offer holds this operation (item
   * 6); absent, the tag's default applies. Never widens admission. */
  relevance?: readonly AssistantPage[];
  toolInput?: { closed?: boolean; multipart?: { field: string; filename: string; content: string } };
  requestBody?: unknown;
  responses: Record<string, unknown>;
  parameters?: unknown[];
}) {
  const bound = (config.requestBody as { "x-byte-limit"?: number } | undefined)?.["x-byte-limit"];
  const code = (config.requestBody as { "x-byte-error"?: string } | undefined)?.["x-byte-error"] ?? "request_body_too_large";
  const admission = bound && !config.description?.includes(`At most ${bound.toLocaleString("en-US")} wire bytes`) ? `At most ${bound.toLocaleString("en-US")} wire bytes; a larger body is refused with \`${code}\` before JSON parsing. ` : "";
  return {
    summary: config.summary,
    description: admission + (config.description ?? ""),
    tags: [config.tag],
    "x-tool": config.tool,
    ...(config.toolInput ? { "x-tool-input": config.toolInput } : {}),
    "x-effects": config.effects,
    ...(config.mcp ? { "x-mcp": config.mcp } : {}),
    ...(config.tool !== false ? { "x-tool-output": { envelope: "result-history" as const, ...config.toolOutput } } : {}),
    ...(config.confirmation ? { "x-confirmation": config.confirmation } : {}),
    ...(config.display ? { "x-display": config.display } : {}),
    ...(config.relevance ? { "x-relevance": config.relevance } : {}),
    ...(config.confirm ? { "x-confirm": config.confirm } : {}),
    ...(config.parameters ? { parameters: config.parameters } : {}),
    ...(config.requestBody ? { requestBody: config.requestBody } : {}),
    responses: { ...config.responses, ...(bound ? { "413": ERROR_RESPONSE } : {}), default: ERROR_RESPONSE },
  };
}

export const jsonOk = (ref: string, description = "Success.") => ({
  description,
  content: { "application/json": { schema: { $ref: ref } } },
});

export const pathParam = (name: string, description: string) => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string" },
  description,
});

