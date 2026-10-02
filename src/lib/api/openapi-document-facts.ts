/** Safe facts on reached document reads. Anonymous projections never use it. */
export const DOCUMENT_FACT_PROPERTIES = {
  editRevision: { type: "string", pattern: "^[0-9a-f]{32}$", description: "Opaque durable revision paired with this document state. Camera and derived writes do not change it." },
  lastChangedAt: { type: ["string", "null"], format: "date-time", description: "Time of the last accepted covered change, independent of camera and cache clocks." },
  lastChangedBy: { type: ["object", "null"], description: "The acting account's display and fixed SQL names; null explicitly means unknown. Never inferred from ownership.",
    properties: { name: { type: "string" }, sqlName: { type: "string" } }, required: ["name", "sqlName"], additionalProperties: false },
};
export const DOCUMENT_FACT_SCHEMA = { type: "object", properties: DOCUMENT_FACT_PROPERTIES,
  required: ["editRevision", "lastChangedAt", "lastChangedBy"] };

export const EDIT_REVISION_SCHEMA = { type: "object", properties: { editRevision: DOCUMENT_FACT_PROPERTIES.editRevision }, required: ["editRevision"] };
export const DOCUMENT_RESULTS_SCHEMA = { type: "object", properties: {
  revisions: { type: "array", description: "Resulting revisions for each affected surviving map or workflow the caller still reaches, including withdrawn filings. Empty when none remain reachable.",
    items: { type: "object", properties: { kind: { type: "string", enum: ["map", "workflow"] }, id: { type: "string" }, editRevision: DOCUMENT_FACT_PROPERTIES.editRevision }, required: ["kind", "id", "editRevision"] } },
}, required: ["revisions"] };
