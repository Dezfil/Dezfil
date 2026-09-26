const text = { type: "string" };
const id = { type: "string", minLength: 1 };
const optionalId = { type: ["string", "null"], minLength: 1 };
const nullableText = { type: ["string", "null"] };
const count = { type: "integer", minimum: 0 };
const object = (properties: Record<string, unknown>) => ({
  type: "object", additionalProperties: false, properties, required: Object.keys(properties),
});

export const ASSISTANT_CONTEXT_SCHEMAS = {
  AssistantContext: {
    description: "Optional page grounding, at most 64 KiB of UTF-8 JSON. Omission makes no page claim. Unknown fields, malformed snapshots and incompatible object ownership refuse before work with assistant_context_invalid; oversized context answers 413 assistant_context_too_large. Server-owned identities are checked against this instance. SQL is an exact browser-submitted snapshot, not a draft write, execution or approval. A table preview is not a last execution.",
    oneOf: [
      {
        type: "object", additionalProperties: false,
        required: ["page", "mapId", "selectedLayerId"],
        properties: {
          page: { const: "builder" }, mapId: id, selectedLayerId: optionalId,
          // Optional, because the reader accepts the page without it and reads
          // its absence as light. Closing it out of the variant refused what
          // the builder actually sends.
          appearance: { type: "string", enum: ["light", "dark"], description: "The builder's resolved theme, so an automatic map check renders the appearance the person is looking at. Absent means light." },
        },
      },
      object({
        page: { const: "sql" }, draft: text, selection: nullableText,
        lastExecution: {
          oneOf: [
            { type: "null" },
            object({ sql: text, result: { $ref: "#/components/schemas/AssistantSqlResultSummary" } }),
            object({ sql: text, error: object({ code: id, message: text }) }),
          ],
        },
      }),
      object({ page: { const: "workflow" }, recipeId: id, selectedStepId: optionalId, lastRunId: optionalId }),
    ],
  },
  AssistantSqlResultSummary: {
    ...object({
      totalRows: count, returnedRows: count, truncated: { type: "boolean" },
      columns: { type: "array", items: object({ name: text, type: text }) },
      elapsedMs: { type: "number", minimum: 0 },
    }),
    description: "The result of this exact executed SQL. Returned rows cannot exceed total rows. No row samples are submitted as automatic grounding.",
  },
};
