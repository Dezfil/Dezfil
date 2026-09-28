import { authenticatedOp as op } from "./openapi-authenticated";
import { jsonOk, pathParam } from "./openapi-helpers";
import { READ_ONLY, writes, resource } from "./operation-metadata";

/** Execution ownership belongs to clients; models cannot reserve themselves. */
export const ASSISTANT_RUN_PATHS = {
  "/api/assistant/runs": {
    post: op({
      summary: "Reserve an assistant run",
      description: "Obtain a server-issued run identity bound to the authenticated account before sending a new message. Performs no model or product operation. Eight reserved, running or awaiting-confirmation runs share capacity; unused reservations expire after five minutes. Capacity refusal preserves occupied slots and points to GET /api/assistant/pending and DELETE /api/assistant/runs/{id} for recovery or release.",
      tag: "Agents", tool: false, effects: writes(resource("assistant")),
      responses: { "201": jsonOk("#/components/schemas/AssistantRun") },
    }),
  },
  "/api/assistant/runs/{id}": {
    get: op({
      summary: "Read assistant recovery state",
      description: "Only the reserving account can read or control this run; another account receives 404 assistant_run_unavailable. Read reserved, running, awaiting_confirmation, completed, interrupted, failed or unavailable state, received text, attempted actions, known outcomes and the original open pending action. No replay or continuation occurs. Unknown, evicted and pre-restart identities answer 404 assistant_run_unavailable. Only the newest 256 terminal receipts are retained, each at most 64 KiB; incomplete marks omitted text or arguments. Raw tool result bodies are never retained. Live recovery is bounded to 1 MiB, with oversized proposed actions refused before execution. provenance carries the model choice the run bound and, separately, the identities its completed provider responses reported, inside those same bounds.",
      tag: "Agents", tool: false, effects: READ_ONLY,
      parameters: [pathParam("id", "Server-issued run identity")],
      responses: { "200": jsonOk("#/components/schemas/AssistantRun") },
    }),
    delete: op({
      summary: "Release an assistant reservation or abandon a pending turn",
      description: "Release an unused reservation (state becomes unavailable) or abandon an awaiting-confirmation turn (interrupted, pending action superseded). Neither starts model or tool work. Other states refuse with 409 assistant_run_state. Frees admission capacity; the old identity never starts new work.",
      tag: "Agents", tool: false, effects: writes(resource("assistant", "id")),
      parameters: [pathParam("id", "Server-issued run identity")],
      responses: { "200": jsonOk("#/components/schemas/AssistantRun") },
    }),
  },
  "/api/assistant/runs/{id}/cancel": {
    post: op({
      summary: "Cancel active assistant execution",
      description: "Stops further admission and cancels an active provider or read-only tool request. A dispatched mutation settles to its known API outcome; an unknown outcome stays uncertain and is never re-executed. Accepted asynchronous jobs retain their own lifecycle and identity. Closing the execution stream has the same effect. Completed changes remain and an already parked confirmation stays recoverable. Closing a duplicate observer or recovery read cannot cancel the execution. Read the run again to observe settlement; this request does not wait for it.",
      tag: "Agents", tool: false, effects: writes(resource("assistant", "id")),
      parameters: [pathParam("id", "Server-issued run identity")],
      responses: { "200": jsonOk("#/components/schemas/AssistantRun") },
    }),
  },
  "/api/assistant/pending": {
    get: op({
      summary: "List open assistant confirmations",
      description: "Returns only the caller’s open pending actions (at most eight) with runId, server-issued pending id, original tool, exact arguments and confirmation words. Includes actions whose stream event was lost; read on pane mount. Pending actions have no wall-clock expiry. This read starts no work.",
      tag: "Agents", tool: false, effects: READ_ONLY,
      responses: { "200": jsonOk("#/components/schemas/AssistantPendingList") },
    }),
  },
};
