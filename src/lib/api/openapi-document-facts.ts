import { ERROR_RESPONSE } from "./openapi-helpers";
/** All three actor positions share this exact published union. */
export const ACCOUNT_ACTOR_SCHEMA = {
  description: "A named actor has display and fixed SQL names. { deleted: true } explicitly identifies a deleted actor and carries no names or profile fields. Null explicitly means unknown. Never inferred from ownership.",
  oneOf: [
    { type: "object", properties: { name: { type: "string" }, sqlName: { type: "string" } }, required: ["name", "sqlName"], additionalProperties: false },
    { type: "object", properties: { deleted: { type: "boolean", const: true } }, required: ["deleted"], additionalProperties: false },
    { type: "null" },
  ],
};
/** Safe facts on reached document reads. Anonymous projections never use it. */
export const DOCUMENT_FACT_PROPERTIES = {
  editRevision: { type: "string", pattern: "^[0-9a-f]{32}$", description: "Opaque durable revision paired with this document state. Camera and derived writes do not change it." },
  lastChangedAt: { type: ["string", "null"], format: "date-time", description: "Time of the last accepted covered change, independent of camera and cache clocks." },
  lastChangedBy: ACCOUNT_ACTOR_SCHEMA,
};
export const DOCUMENT_FACT_SCHEMA = { type: "object", properties: DOCUMENT_FACT_PROPERTIES,
  required: ["editRevision", "lastChangedAt", "lastChangedBy"] };

export const EDIT_REVISION_SCHEMA = { type: "object", properties: { editRevision: DOCUMENT_FACT_PROPERTIES.editRevision }, required: ["editRevision"] };
export const DOCUMENT_RESULTS_SCHEMA = { type: "object", properties: {
  revisions: { type: "array", description: "Resulting revisions for each affected surviving map or workflow the caller still reaches, including withdrawn filings. Empty when none remain reachable.",
    items: { type: "object", properties: { kind: { type: "string", enum: ["map", "workflow"] }, id: { type: "string" }, editRevision: DOCUMENT_FACT_PROPERTIES.editRevision }, required: ["kind", "id", "editRevision"] } },
}, required: ["revisions"] };

/** Declared only as each operation enforces its request precondition. */
export const editRevisionParam = {
  name: "X-Edit-Revision", "x-tool-name": "expected_revision", in: "header", required: true,
  schema: DOCUMENT_FACT_PROPERTIES.editRevision,
  description: "Read the document first and send its editRevision. Missing or malformed: 400 invalid_request. Stale: 409 stale_revision, with no changes. Chain accepted results; reload explicitly after refusal.",
};
export const conditionalMapRevisionParam = { ...editRevisionParam, required: false,
  description: editRevisionParam.description + " Required for any content field, including a no-op or content combined with viewport. Viewport-only writes need no revision and change no edit revision, history or attribution." };

export const editRevisionResponses = { "400": ERROR_RESPONSE, "409": ERROR_RESPONSE };
