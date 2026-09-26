import type { ToolDef } from "@/lib/tools/tools";

/**
 * What the Anthropic adapter may put on the wire. The API refuses `anyOf`,
 * `oneOf` and `allOf` at the top level of a tool's input schema and answers
 * the whole request with a 400, so no turn completes while one is offered.
 * Unions nested inside properties are accepted and stay.
 *
 * Two things happen here, and nothing else: the top-level union keywords are
 * dropped from the schema this provider sends, and what the union said is
 * appended to the tool's description as a plain fact, derived from the union's
 * own branches rather than written per tool. The schema Dezfil validates
 * against (`tool.inputSchema`) is untouched, so the constraint still refuses a
 * call before it is dispatched; only the model's copy loses the keyword.
 */

const UNION_KEYWORDS = ["anyOf", "oneOf", "allOf"] as const;

/** The keywords a branch may carry and still be described in words. A branch
 * carrying anything else is not described at all: a wrong fact about the
 * arguments is worse than a missing one. */
const DESCRIBABLE = new Set(["type", "properties", "additionalProperties", "required", "description", "title"]);

type Branch = Record<string, unknown>;

const quoted = (names: string[]) => names.map((name) => `\`${name}\``).join(", ");

/** One branch as an argument set: the names it declares, in the schema's own
 * property order, marked "only" when the branch admits nothing else. */
function describeBranch(branch: unknown, order: string[]): string | undefined {
  if (!branch || typeof branch !== "object" || Array.isArray(branch)) return undefined;
  const shape = branch as Branch;
  if (Object.keys(shape).some((key) => !DESCRIBABLE.has(key))) return undefined;
  if (shape.type !== undefined && shape.type !== "object") return undefined;
  if (shape.additionalProperties !== undefined && shape.additionalProperties !== false) return undefined;
  if (shape.required !== undefined && !Array.isArray(shape.required)) return undefined;
  const declared = Object.keys((shape.properties ?? {}) as Record<string, unknown>);
  const names = [...order.filter((name) => declared.includes(name)), ...declared.filter((name) => !order.includes(name))];
  const closed = shape.additionalProperties === false;
  const required = ((shape.required ?? []) as unknown[]).filter((name): name is string => typeof name === "string");
  const tail = required.length ? ` (${quoted(required)} required)` : "";
  if (!names.length) return (closed ? "no arguments" : "any arguments") + tail;
  return `${closed ? "only " : ""}${quoted(names)}${tail}`;
}

/**
 * The union's own words, or nothing. Only `anyOf` is described: `oneOf` also
 * forbids an argument set that matches two branches, and `allOf` is a
 * conjunction, so neither is an "accepted argument sets" list.
 */
export function argumentSetsSentence(schema: Record<string, unknown>): string | undefined {
  const branches = schema.anyOf;
  if (!Array.isArray(branches) || branches.length < 2) return undefined;
  const order = Object.keys((schema.properties ?? {}) as Record<string, unknown>);
  const described = branches.map((branch) => describeBranch(branch, order));
  if (described.some((text) => text === undefined)) return undefined;
  return `Accepted argument sets: ${described.join("; or ")}.`;
}

/** The schema without its top-level union keywords. Nested ones are left alone. */
export function anthropicInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (!UNION_KEYWORDS.some((keyword) => keyword in schema)) return schema;
  const stripped = { ...schema };
  for (const keyword of UNION_KEYWORDS) delete stripped[keyword];
  return stripped;
}

export interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export function anthropicTool(tool: ToolDef): AnthropicToolDefinition {
  const schema = tool.inputSchema as unknown as Record<string, unknown>;
  const sentence = argumentSetsSentence(schema);
  return {
    name: tool.name,
    description: sentence ? `${tool.description}\n\n${sentence}` : tool.description,
    input_schema: anthropicInputSchema(schema),
  };
}
