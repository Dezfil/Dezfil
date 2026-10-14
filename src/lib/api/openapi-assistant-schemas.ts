import { ASSISTANT_EVENT_SCHEMAS, OBSERVATION_REASONS } from "./openapi-assistant-events";
import { ERROR_CATALOGUE } from "./error-catalogue";
import { ASSISTANT_CONTEXT_SCHEMAS } from "./openapi-assistant-context";

/** Why a turn ended, as the loop's done event reports it. */
const DONE_REASONS = ["end", "budget", "interrupted"] as const;

export const ASSISTANT_SCHEMAS = {
  ...ASSISTANT_CONTEXT_SCHEMAS,
  ...ASSISTANT_EVENT_SCHEMAS,
  AssistantModelChoice: {
    type: "object", required: ["id", "name", "efforts"],
    description:
      "A model a request may choose on this instance. The effort levels are that model's own, " +
      "in its provider's own words as Dezfil knows them: there is no shared scale, and no equivalence of " +
      "computational work across models or providers is claimed. Every model offers the entry \"default\": " +
      "the provider's own no-choice behavior, which is what a request with no effort resolves to. A model " +
      "Dezfil knows no levels for offers that entry alone, which states what Dezfil supports and never that " +
      "the provider lacks the capability. This list is exactly the accepted set: every value here is accepted " +
      "for this model, and no other value is.",
    properties: {
      id: { type: "string", description: "The identity a request names in choice.model." },
      name: { type: "string", description: "A display name; an identity with no display name reads as itself." },
      efforts: {
        type: "array",
        items: {
          type: "object", required: ["value", "label"],
          properties: {
            value: { type: "string", description: "The word a request names in choice.effort." },
            label: { type: "string" },
          },
        },
      },
    },
  },
  AssistantCatalogueState: {
    description: "The current local model catalogue. The optional assistant-models.json in DEZFIL_DATA_DIR adds and overrides entries. A missing or rejected copy uses shipped knowledge; a valid copy, including an empty one, reports merged. A rejection reason names the invalid field or read failure without file contents. Each enabled status read and new message admission reads the current files.",
    oneOf: [
      {
        type: "object", additionalProperties: false, required: ["source", "instance"],
        properties: { source: { const: "shipped" }, instance: { const: "absent" } },
      },
      {
        type: "object", additionalProperties: false, required: ["source", "instance"],
        properties: { source: { const: "merged" }, instance: { const: "applied" } },
      },
      {
        type: "object", additionalProperties: false, required: ["source", "instance", "reason"],
        properties: { source: { const: "shipped" }, instance: { const: "rejected" }, reason: { type: "string" } },
      },
    ],
  },
  AssistantProvenance: {
    type: "object",
    description:
      "What a run asked for and what its provider answers reported. Two separate facts: a " +
      "requested setting is never evidence of the reasoning work a provider actually did.",
    properties: {
      requested: {
        type: "object", required: ["model", "effort", "defaulted"],
        description:
          "The pair the first accepted submission bound, written before any provider request exists, so a run " +
          "that fails before an answer still reports it. effort is \"default\" where none was chosen.",
        properties: {
          model: { type: "string" },
          effort: { type: "string" },
          defaulted: {
            type: "object", required: ["model", "effort"],
            description: "Which halves the instance supplied rather than the requester.",
            properties: { model: { type: "boolean" }, effort: { type: "boolean" } },
          },
        },
      },
      reported: {
        type: "array",
        description:
          "The distinct identities completed provider responses reported, in first-seen order; a null entry is a " +
          "response that completed reporting none. Absent means no provider response completed at all, which is " +
          "not the same fact as a response that named nothing.",
        items: { type: ["string", "null"] },
      },
    },
  },
  AssistantPolicy: {
    type: "object", required: ["page", "policy", "offer", "admitted", "offered", "discovery"],
    description: "A page's action policy and default offer. admitted is every operation a run under the page may call; offered is what its model is shown at the start, the discovery tool included when discovery is on; discovery says whether the admitted operations outside the offer are reachable through it. offer names the mode: subset (the page's operations and the grounding reads) or full (every admitted operation).",
    properties: {
      page: { type: "string", enum: ["builder", "sql", "workflow"] },
      policy: { type: "string", enum: ["full", "read_only"] },
      offer: { type: "string", enum: ["subset", "full"] },
      admitted: { type: "array", items: { type: "string" } },
      offered: { type: "array", items: { type: "string" } },
      discovery: { type: "boolean" },
    },
  },
  AssistantPendingList: {
    type: "object", required: ["pending"],
    properties: { pending: { type: "array", maxItems: 8, items: { $ref: "#/components/schemas/AssistantPendingAction" } } },
  },
  AssistantRun: {
    type: "object",
    description: "Read-only progress snapshot. Observation starts no work and cannot resume an interrupted run. Working state is lost on process replacement.",
    required: ["id", "state", "text", "actions", "incomplete"],
    properties: {
      id: { type: "string" },
      state: { type: "string", enum: ["reserved", "running", "awaiting_confirmation", "completed", "interrupted", "failed", "unavailable"] },
      text: { type: "string" }, actions: { type: "array", items: { $ref: "#/components/schemas/AssistantAction" } },
      pending: { $ref: "#/components/schemas/AssistantPendingAction" }, error: { type: "object" }, incomplete: { type: "boolean" },
      confirmations: { type: "array", items: { $ref: "#/components/schemas/AssistantConfirmationRecord" }, description: "Settled confirmations of this run, in order." },
      provenance: { $ref: "#/components/schemas/AssistantProvenance" },
    },
  },
        AssistantStatus: {
          type: "object",
          additionalProperties: false,
          properties: {
            enabled: { type: "boolean" },
            reason: { type: "string", description: "Present when disabled." },
            provider: { type: "string", description: "Present when enabled." },
            model: { type: "string", description: "Present when enabled." },
            catalogue: { $ref: "#/components/schemas/AssistantCatalogueState", description: "Present when enabled; absent when disabled." },
            stepBudget: { type: "integer", description: "Present when enabled." },
            autoCheck: { type: "boolean", description: "Present when enabled: whether the assistant checks the map by itself after a turn that changed it. The instance owner's setting, DEZFIL_ASSISTANT_AUTO_CHECK, on by default; 0, false or off turns it off. An explicit check is available whatever this says." },
            models: {
              type: "array", items: { $ref: "#/components/schemas/AssistantModelChoice" },
              description:
                "Present when enabled: every model a request may choose on this instance, the " +
                "resolved provider's list alone, with the default among them exactly once. The instance owner " +
                "narrows and orders it with DEZFIL_AI_MODELS_ANTHROPIC or DEZFIL_AI_MODELS_OPENAI. " +
                "Unset offers the effective catalogue in file order. A set empty or separators-only list offers " +
                "the default alone. The default stays where listed or is prepended when missing. Unknown " +
                "identities read as themselves with default effort alone. Listing an identity " +
                "grants permission to request it; whether the provider has it is the provider's own answer.",
            },
          },
          required: ["enabled"],
        },
        AssistantRequest: {
          description:
            "Either a message (optionally with history and a superseded " +
            "pending action) or a resolution, never both.",
          oneOf: [
            {
              type: "object",
              title: "Message",
              properties: {
                runId: { type: "string", description: "Identity obtained before submission from POST /api/assistant/runs." },
                message: { type: "string" },
                context: { $ref: "#/components/schemas/AssistantContext" },
                history: {
                  type: "array",
                  description:
                    "Prior turns as {role, text}; conversations are not stored server-side.",
                  items: {
                    type: "object",
                    properties: {
                      role: { type: "string", enum: ["user", "assistant"] },
                      text: { type: "string" },
                    },
                  },
                },
                supersedes: {
                  type: "string",
                  description:
                    "A pending-action id this message abandons (the implicit " +
                    "decline). Unknown ids are ignored.",
                },
                choice: {
                  type: "object",
                  description:
                    "Optional: the model and the effort this run is sent to, both optional " +
                    "inside it. An omitted model is the instance default; an omitted effort is the selected " +
                    "model's provider-default entry; an empty choice is an omission. GET /api/assistant reports " +
                    "what this instance offers. The first accepted submission binds the pair for the whole run, " +
                    "tool continuations, confirmation continuations and the map check's observation included; a " +
                    "choice supplied on a resolution is ignored, as a context supplied there already is. A " +
                    "malformed choice (400 assistant_choice_invalid), a model this instance does not offer (400 " +
                    "assistant_model_not_offered), an effort the selected model does not offer (400 " +
                    "assistant_effort_not_offered) and a named level for a model that has no levels of its own " +
                    "(400 assistant_effort_not_supported) are each refused before the run binds and before any " +
                    "provider call or product operation, leaving the reservation unbound and reusable. The " +
                    "entry \"default\" is accepted for every offered model and resolves exactly as omitting the " +
                    "effort does; the two differ only in what provenance.requested.defaulted records.",
                  additionalProperties: false,
                  properties: {
                    model: { type: "string", description: "An identity from the status read's models." },
                    effort: { type: "string", description: "One of that model's own effort values, \"default\" among them." },
                  },
                },
              },
              required: ["message", "runId"],
              not: { required: ["resolution"] },
            },
            {
              type: "object",
              title: "Resolution",
              description:
                "Resolve the confirmation a confirm_required event raised, " +
                "instead of sending a message. Binds to the server-issued " +
                "pending-action id; at most one resolution ever takes effect. " +
                "Any context supplied on a resolution is ignored; the run retains " +
                "its original context while server-owned facts are refreshed.",
              properties: {
                resolution: {
                  type: "object",
                  properties: {
                    pending: { type: "string" },
                    approved: { type: "boolean" },
                  },
                  required: ["pending", "approved"],
                },
              },
              required: ["resolution"],
              not: { required: ["message"] },
            },
          ],
        },
        AssistantEvent: {
          type: "object",
          description:
            "One streamed event. text_delta carries an incremental text chunk and messageId; message carries the complete text for that same messageId. Legacy clients ignore deltas; delta-aware clients replace that message at completion, never append it twice. Recovery text is a replacement snapshot, not a delta. Partial tool arguments and private reasoning are not emitted or executed. Action events carry resolved effects; confirm_required carries target and consequence words. outcome distinguishes succeeded, accepted, refused and uncertain; jobId identifies accepted asynchronous work. `type` is one of text_delta, message, tool_call, " +
            "tool_result, observation, confirm_required, error, done. On confirm_required, " +
            "`id` is the server-issued pending-action id a resolution " +
            "references (not a provider tool-call id); the run has paused " +
            "and the stream ends until a resolution request continues it.",
          properties: {
            type: {
              type: "string",
              enum: [
                "text_delta",
                "message",
                "tool_call",
                "tool_result",
                "observation",
                "confirm_required",
                "error",
                "done",
              ],
            },
            text: { type: "string" },
            messageId: { type: "string" },
            model: { type: "string", description: "Actual provider model on a completed model message." },
            effects: { $ref: "#/components/schemas/AssistantEffects" },
            confirmation: { $ref: "#/components/schemas/AssistantConfirmation" },
            callId: { type: "string", description: "On confirm_required: the provider tool-call id the gate holds." },
            outcome: { type: "string", enum: ["succeeded", "accepted", "refused", "uncertain"] },
            jobId: { type: "string" },
            label: { type: "string", description: "On tool_call and tool_result: the record's line for the action." },
            subject: { $ref: "#/components/schemas/AssistantSubject" },
            elapsedMs: { type: "integer", minimum: 0, description: "On tool_result: execution time around the dispatch alone." },
            history: { $ref: "#/components/schemas/AssistantHistory" },
            decision: { type: "string", enum: ["approved", "declined"], description: "On the tool_result a resolution settled: how." },
            render: { $ref: "#/components/schemas/MapLookRender", description: "On a map check's tool_result: the render's facts, never its bytes." },
            automatic: { type: "boolean", enum: [true], description: "On a map check's tool_call and tool_result: the loop scheduled it itself." },
            state: { type: "string", enum: ["awaited", "captured", "silent", "interrupted", "unavailable"], description: "On observation: the observation's lifecycle state; id names the check action, text the displayed sentence, reason why none will come." },
            id: { type: "string" },
            tool: { type: "string" },
            args: { type: "object" },
            ok: { type: "boolean" },
            body: {},
            code: { type: "string", enum: Object.keys(ERROR_CATALOGUE) },
            message: { type: "string" },
            reason: { type: "string", enum: [...DONE_REASONS, ...OBSERVATION_REASONS], description: "On done: why the turn ended (end, budget, interrupted). On observation: why no observation will come (cancelled, exhausted, failed); the loop yields exhausted when the last step was spent on the check itself." },
          },
          required: ["type"],
        },
};
