/** Safe facts on reached document reads. Anonymous projections never use it. */
export const DOCUMENT_FACT_PROPERTIES = {
  editRevision: { type: "string", pattern: "^[0-9a-f]{32}$", description: "Opaque durable revision paired with this document state. Camera and derived writes do not change it." },
  lastChangedAt: { type: ["string", "null"], format: "date-time", description: "Time of the last accepted covered change, independent of camera and cache clocks." },
  lastChangedBy: { type: ["object", "null"], description: "The acting account's display and fixed SQL names; null explicitly means unknown. Never inferred from ownership.",
    properties: { name: { type: "string" }, sqlName: { type: "string" } }, required: ["name", "sqlName"], additionalProperties: false },
};
export const DOCUMENT_FACT_SCHEMA = { type: "object", properties: DOCUMENT_FACT_PROPERTIES,
  required: ["editRevision", "lastChangedAt", "lastChangedBy"] };
