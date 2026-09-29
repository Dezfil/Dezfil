// Node 24 preserves the original numeric token in reviver context. Keep it
// when JS numbers would round a BIGINT or DECIMAL during the AST round trip.
const sourceJson = JSON as typeof JSON & { rawJSON(source: string): unknown };
export function parseSqlJson(text: string): Record<string, unknown> {
  return JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) =>
    typeof value === "number" && !Number.isSafeInteger(value) && context?.source
      ? sourceJson.rawJSON(context.source) : value);
}
