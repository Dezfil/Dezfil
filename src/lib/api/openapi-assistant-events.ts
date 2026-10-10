/** Why no observation will come, shared by the observation's own object
 * and by the streamed event that carries it. */
export const OBSERVATION_REASONS = ["cancelled", "exhausted", "failed"] as const;

/** Additive event metadata also supplies the recovery representation. */
export const ASSISTANT_EVENT_SCHEMAS = {
  AssistantEffects: {
    type: "object", required: ["readOnly", "writes"],
    properties: {
      readOnly: { type: "boolean" },
      writes: { type: "array", items: {
        type: "object", required: ["resource", "ids", "collection"],
        properties: {
          resource: { type: "string", enum: ["maps", "layers", "tables", "publications", "recipes", "runs", "projects", "connections", "palettes", "settings", "caches", "basemaps", "assistant"] },
          ids: { type: "array", items: { type: "string" } },
          collection: { type: "boolean", description: "True when a narrower identity cannot be established." },
        },
      } },
    },
  },
  AssistantConfirmation: {
    type: "object", required: ["target", "consequence"],
    properties: { target: { type: "string" }, consequence: { type: "string" } },
  },
  AssistantSubject: {
    type: "object", required: ["resource"],
    description: "The subject of an action as resolved when it happened: its resource, its identity when the call or response named one, and its display name when one was carried. A later rename or deletion does not change it.",
    properties: {
      resource: { type: "string", enum: ["maps", "layers", "tables", "publications", "recipes", "runs", "projects", "connections", "palettes", "settings", "caches", "basemaps", "assistant"] },
      id: { type: "string" }, name: { type: "string" },
    },
  },
  AssistantHistory: {
    type: "object", required: ["mapId", "group"],
    description: "Where a change qualifies for a map's history: the map and the change group the turn stamped. A turn may touch several maps and a manual edit during a pause splits its steps, so a group is the turn's marker, never a claim that it is one currently undoable step.",
    properties: { mapId: { type: "string" }, group: { type: "string" } },
  },
  AssistantObservation: {
    type: "object", required: ["state"],
    description: "The observation attached to a map check: a separate fact recorded when the model's subsequent text arrived, never a change to the check's outcome. awaited: the check settled and the text has not come; captured: text holds the first subsequent sentence, at most 240 characters cut at a word boundary, and at is where in the run's text it begins; silent: the turn completed with no subsequent text; interrupted: no text will come, reason says why (cancelled, exhausted, failed); unavailable: the terminal compaction dropped the detail. Absence of this object on a check that did not succeed means the check produced no image.",
    properties: {
      state: { type: "string", enum: ["awaited", "captured", "silent", "interrupted", "unavailable"] },
      text: { type: "string" },
      at: { type: "integer", minimum: 0 },
      reason: { type: "string", enum: [...OBSERVATION_REASONS] },
    },
  },
  AssistantAction: {
    type: "object", required: ["id", "tool", "status"],
    description: "A known attempted action, never a raw tool-result body. Effects describe possible resources. Status distinguishes success, accepted asynchronous work (jobId), refusal and uncertainty. Additive facts recorded when the action happened: elapsedMs measures the dispatch alone, never a gate's wait; history names the map and change group of a qualifying change and is absent for excluded ones; decision says how a resolution settled a gated call; omitted marks an action whose arguments the terminal compaction dropped, so unavailable detail is never shown as empty. Missing text is covered by the receipt's incomplete flag. A map check carries render, its facts without bytes, observation, the separate later fact with its lifecycle, and automatic when the loop scheduled it itself. A terminal compaction may have dropped the render's detail lists, which is why this render's state has them optional while the check's own response does not.",
    properties: {
      id: { type: "string" }, tool: { type: "string" }, args: { type: "object" },
      status: { type: "string", enum: ["attempted", "succeeded", "refused", "uncertain", "accepted"] },
      effects: { $ref: "#/components/schemas/AssistantEffects" }, jobId: { type: "string" },
      label: { type: "string", description: "The record's line for the action, composed from the operation's declared display when it happened." },
      subject: { $ref: "#/components/schemas/AssistantSubject" },
      elapsedMs: { type: "integer", minimum: 0 },
      history: { $ref: "#/components/schemas/AssistantHistory" },
      decision: { type: "string", enum: ["approved", "declined"] },
      omitted: { type: "boolean", enum: [true] },
      render: { $ref: "#/components/schemas/RecordedMapLookRender" },
      observation: { $ref: "#/components/schemas/AssistantObservation" },
      automatic: { type: "boolean", enum: [true] },
    },
  },
  AssistantConfirmationRecord: {
    type: "object", required: ["id", "runId", "tool", "decision"],
    description: "A settled confirmation, kept in the receipt when its pending representation goes: the exact action and the words as presented, with the decision. Approved and declined settle through a resolution; superseded through a newer message naming it or a release. Approval's outcome is the action's own record entry, failure included.",
    properties: {
      id: { type: "string" }, runId: { type: "string" }, tool: { type: "string" }, args: { type: "object" },
      confirmation: { $ref: "#/components/schemas/AssistantConfirmation" },
      effects: { $ref: "#/components/schemas/AssistantEffects" },
      decision: { type: "string", enum: ["approved", "declined", "superseded"] },
      callId: { type: "string", description: "The tool-call id the gate held; absent from the actions when the continuation stopped before the call ran." },
      omitted: { type: "boolean", enum: [true], description: "The terminal compaction dropped this gate's arguments; the decision and the words stand." },
    },
  },
  AssistantPendingAction: {
    type: "object", required: ["id", "runId", "tool", "args"],
    description: "Exact open action, bound to the original run and target. A confirmation resolution uses id, while recovery uses runId. Confirmation words remain those presented when the action parked.",
    properties: {
      id: { type: "string" }, runId: { type: "string" }, tool: { type: "string" }, args: { type: "object" },
      confirmation: { $ref: "#/components/schemas/AssistantConfirmation" },
      effects: { $ref: "#/components/schemas/AssistantEffects" },
      callId: { type: "string", description: "The tool-call id the gate holds: the action it runs as on approval, so a settled gate can be matched with its action or seen to have run as none." },
    },
  },
};
