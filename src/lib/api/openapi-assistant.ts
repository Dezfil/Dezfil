import { authenticatedOp as op } from "./openapi-authenticated";
import { ASSISTANT_RUN_PATHS } from "./openapi-assistant-runs";
import { jsonOk } from "./openapi-helpers";
import { READ_ONLY, writes, resource } from "./operation-metadata";

/** Assistant lifecycle operations are documented clients, excluded from model tools. */
export const ASSISTANT_PATHS = {
  ...ASSISTANT_RUN_PATHS,
      "/api/assistant": {
        get: op({
          summary: "Assistant status",
          description:
            "Whether the in-product assistant is enabled. When enabled, " +
            "reports the resolved provider, model, step budget and whether the " +
            "map is checked automatically after a turn that changed it, " +
            "and every model a request may choose on this instance with that " +
            "model's own effort levels. When not, " +
            "reports the reason and how to enable it. The model credential is " +
            "never included. Enablement is a deployment setting (an Anthropic " +
            "or OpenAI API key); with none, this is a complete non-assistant " +
            "instance and the surface is absent.",
          tag: "Agents",
          tool: false,
          effects: READ_ONLY,
          responses: {
            "200": jsonOk("#/components/schemas/AssistantStatus"),
          },
        }),
      },
      "/api/assistant/policy": {
        get: op({
          summary: "Read a page's assistant policy and default offer",
          description:
            "For a page (builder, sql or workflow), the action policy its runs bind with, " +
            "every operation that policy admits, the operations a run under that page is offered at its start " +
            "(the page's relevant operations and the grounding reads, inside admission), and " +
            "whether discovery is offered to reach the admitted operations the offer omits. Reports the same " +
            "derivation the message route applies. Starts no work. A page outside the three answers 400 invalid_request.",
          tag: "Agents",
          tool: false,
          effects: READ_ONLY,
          parameters: [{ name: "page", in: "query", required: true, schema: { type: "string", enum: ["builder", "sql", "workflow"] }, description: "The page the run would carry as its context." }],
          responses: { "200": jsonOk("#/components/schemas/AssistantPolicy") },
        }),
      },
      "/api/assistant/messages": {
        post: op({
          summary: "Send a message to the assistant",
          description:
            "Reservations and pending actions are bound to their account. Every continuation reauthenticates that same account and uses its current permissions. A foreign run is unavailable; a foreign pending action is unknown. Grounding, subject reads, execution and automatic checks use the caller’s bearer-equivalent identity on every internal request. No credential is retained with a pending action. Every new message requires a runId from POST /api/assistant/runs. Unreserved requests refuse with 400 assistant_reservation_required before work. Unknown or evicted identities refuse with 404 assistant_run_unavailable. The first accepted submission binds its message, history, context and supersession. Identical concurrent or later submissions return an application/json AssistantRun snapshot without another exchange; changed input refuses with 409 assistant_run_conflict. Plain-English request; the assistant works through the same " +
            "documented API these docs describe and streams its actions back " +
            "as newline-delimited JSON events (application/x-ndjson): assistant " +
            "text, tool calls and their results, confirmation prompts for " +
            "destructive or publishing actions, and a terminal done/error. " +
            "A confirm_required event pauses the run and carries a " +
            "server-issued pending-action id; resolve it by posting a " +
            "resolution referencing that id. Approval executes exactly the " +
            "presented action once and the run continues where it paused, a " +
            "decline skips it and the assistant finishes its turn. A pending " +
            "action resolves at most once (409 pending_resolved on a repeat); " +
            "a new message may name a pending action it supersedes (the " +
            "implicit decline), after which resolution answers 409 " +
            "pending_superseded. A hidden or unknown pending id cannot be resolved; naming one only to supersede it is a harmless no-op. Pending actions are working state, and " +
            "bounded: after a container replacement resolution answers 404 " +
            "pending_unknown and nothing re-runs; only a small number of " +
            "reserved, running or parked runs share eight admission slots. " +
            "A full instance refuses new reservations with assistant_capacity; " +
            "live and pending runs are never silently evicted. Only unused " +
            "reservations expire after five minutes. Pending turns have no " +
            "wall-clock expiry and are recoverable through GET /api/assistant/pending. " +
            "Release a reservation or abandon a pending turn with DELETE " +
            "/api/assistant/runs/{id}. The resolved trace " +
            "behind the 409 answers is bounded, so a sufficiently old repeat " +
            "answers pending_unknown instead. The step budget spans the " +
            "whole turn, pauses included. Submissions above 128 KiB refuse with " +
            "assistant_submission_too_large before work. Terminal recovery keeps " +
            "256 receipts of at most 64 KiB; live recovery is at most 1 MiB per " +
            "run and stops with assistant_recovery_limit before protected " +
            "action data would exceed it. Returns 404 with " +
            "assistant_disabled when no model credential is configured. " +
            "The page action policy binds at the first accepted " +
            "submission from the context's page and holds through the run's " +
            "confirmation continuations: a builder context, and no context, " +
            "admit every generated tool with its confirmation gates; a sql " +
            "context and a workflow context admit only the operations that " +
            "declare themselves read-only by their effects, the read-only " +
            "query and the schema reads among them, and no operation that " +
            "declares a write on any argument, conditional (plan or run) " +
            "operations included; of the read-only ones they refuse any that " +
            "reaches outside this server or asks for confirmation, a " +
            "service's or a part's Test among them. The model is offered only what its run " +
            "admits. A call outside the set, however it arrives, is refused " +
            "before any product operation: its tool_result carries the " +
            "documented error assistant_action_not_admitted and the run's " +
            "receipt records the action as refused. " +
            "A message may carry an optional choice of model and effort" +
            "; GET /api/assistant reports what this instance " +
            "offers. It binds with the rest of the submission at the first " +
            "accepted one and holds through every continuation of the run; a " +
            "choice on a resolution is ignored. A malformed choice, a model " +
            "this instance does not offer, an effort the selected model does " +
            "not offer and a named level for a model that has no levels of " +
            "its own refuse with " +
            "400 assistant_choice_invalid, assistant_model_not_offered, " +
            "assistant_effort_not_offered and assistant_effort_not_supported " +
            "respectively, each before the run binds and before any provider " +
            "call or product operation, leaving the reservation unbound and " +
            "reusable. The run's receipt reports the pair it bound and, " +
            "separately, the identities its completed provider responses " +
            "named.",
          tag: "Agents",
          tool: false,
          effects: writes(resource("maps"), resource("layers"), resource("tables"), resource("publications"), resource("recipes"), resource("runs"), resource("projects"), resource("connections"), resource("palettes"), resource("settings"), resource("caches"), resource("basemaps"), resource("assistant")),
          requestBody: {
            "x-byte-limit": 131_072,
            "x-byte-error": "assistant_submission_too_large",
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AssistantRequest" },
                example: {
                  runId: "server-issued-run-id",
                  message: "show me all parks within 500m of a station",
                  history: [],
                },
              },
            },
          },
          responses: {
            "200": {
              description:
                "A stream of newline-delimited assistant events " +
                "(application/x-ndjson).",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/AssistantRun" } },
                "application/x-ndjson": {
                  schema: { $ref: "#/components/schemas/AssistantEvent" },
                },
              },
            },
          },
        }),
      },
};
