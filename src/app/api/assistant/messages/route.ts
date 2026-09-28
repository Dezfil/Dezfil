import { authFailure, privateResponse, requireRequestAuth } from "@/lib/auth/http";
import { requireCurrentActor } from "@/lib/auth/credentials";
import { instanceFetch } from "@/lib/auth/instance-fetch";
import { executionControl, type ExecutionControl } from "@/lib/assistant/execution-control";
import { readSubmission } from "@/lib/assistant/recovery-data";
import { loadGrounding } from "@/lib/assistant/grounding";
import { ApiError, EvaluationCancelled } from "@/lib/api/errors";
import { assistantRuns } from "@/lib/assistant/runs";
import { runStream } from "@/lib/assistant/run-stream";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import { assistantAvailability } from "@/lib/assistant/config";
import { currentAssistantChoices } from "@/lib/assistant/catalogue-choices";
import { chooseForRequest } from "@/lib/assistant/choice";
import { createProvider } from "@/lib/assistant/factory";
import {
  resumeAssistant,
  runAssistant,
} from "@/lib/assistant/loop";
import { pendingActions } from "@/lib/assistant/pending";
import type { HistoryTurn } from "@/lib/assistant/provider";
import { parseAssistantContext } from "@/lib/assistant/context";
import { policyFor } from "@/lib/assistant/policy";
import { selfBaseUrl } from "@/lib/self-url";

/**
 * The conversational exchange. Streams the assistant's actions as
 * newline-delimited JSON events so the builder shows tool calls, results,
 * and confirmation prompts as they happen. Confirmation gating is enforced
 * in the loop, server-side — a UI that hides the prompt cannot bypass it.
 *
 * Two request forms share this endpoint: a message starts a run, and a
 * resolution resumes the run parked at a confirmation, bound to the
 * server-issued pending-action id the confirm_required event carried. A
 * message may also name a pending action it supersedes — the implicit
 * decline when the user moves on instead of answering.
 */

interface RequestBody {
  runId?: unknown;
  context?: unknown;
  message?: unknown;
  history?: unknown;
  supersedes?: unknown;
  resolution?: unknown;
  choice?: unknown;
}

function parseHistory(raw: unknown): HistoryTurn[] {
  if (!Array.isArray(raw)) return [];
  const out: HistoryTurn[] = [];
  for (const item of raw) {
    const turn = item as { role?: unknown; text?: unknown };
    if (
      (turn.role === "user" || turn.role === "assistant") &&
      typeof turn.text === "string"
    ) {
      out.push({ role: turn.role, text: turn.text });
    }
  }
  return out;
}

function parseResolution(raw: unknown): { pending: string; approved: boolean } {
  const r = raw as { pending?: unknown; approved?: unknown };
  if (typeof r?.pending !== "string" || typeof r?.approved !== "boolean") {
    throw new ApiError(
      "invalid_request",
      'A resolution must carry a "pending" id and an "approved" boolean.',
      400,
    );
  }
  return { pending: r.pending, approved: r.approved };
}

export async function POST(request: Request) {
  let claimedRun: string | undefined;
  let control: ExecutionControl | undefined;
  try {
    const actor = requireRequestAuth(request);
    const baseUrl = selfBaseUrl(request);
    const fetchImpl = instanceFetch(baseUrl, actor);
    const availability = assistantAvailability();
    if (!availability.enabled) {
      throw new ApiError("assistant_disabled", availability.reason, 404);
    }

    const body: RequestBody = await readSubmission(request);
    requireCurrentActor(actor);

    if (body.resolution !== undefined) {
      if (body.message !== undefined) {
        throw new ApiError(
          "invalid_request",
          "Send a message or a resolution, not both.",
          400,
        );
      }
      const { pending, approved } = parseResolution(body.resolution);
      const original = pendingActions.peek(pending);
      if (original && original.accountId !== actor.account.id) {
        throw new ApiError("pending_unknown", "No such pending action.", 404);
      }
      const grounding = original ? await loadGrounding(original.context, baseUrl, fetchImpl, request.signal) : undefined;
      requireCurrentActor(actor);
      const parked = pendingActions.claim(
        pending,
        approved ? "approved" : "declined",
      );
      if (!parked) {
        const how = pendingActions.resolutionOf(pending, actor.account.id);
        if (how === "superseded") {
          throw new ApiError(
            "pending_superseded",
            "A newer message superseded this action, declining it.",
            409,
          );
        }
        if (how !== undefined) {
          throw new ApiError(
            "pending_resolved",
            "This action was already resolved; it will not run again.",
            409,
          );
        }
        throw new ApiError(
          "pending_unknown",
          "No such pending action. It may have expired with the server's working state.",
          404,
        );
      }
      claimedRun = parked.runId;
      if (claimedRun) { assistantRuns.resume(claimedRun, approved ? "approved" : "declined"); control = executionControl(claimedRun, request.signal); }
      return privateResponse(runStream(
        resumeAssistant(parked, approved, {
          grounding,
          runId: claimedRun,
          baseUrl, fetchImpl, accountId: actor.account.id,
          signal: control?.signal ?? request.signal,
        }),
        claimedRun,
        control,
      ));
    }

    if (typeof body.message !== "string" || body.message.trim() === "") {
      throw new ApiError(
        "invalid_request",
        'The "message" field must be a non-empty string.',
        400,
      );
    }
    if (typeof body.runId !== "string" || !body.runId) {
      throw new ApiError("assistant_reservation_required", ERROR_CATALOGUE.assistant_reservation_required, 400);
    }
    assistantRuns.requireAccount(body.runId, actor.account.id);
    if (typeof body.supersedes === "string") {
      const abandoned = pendingActions.peek(body.supersedes);
      if (abandoned && abandoned.accountId !== actor.account.id) throw new ApiError("pending_unknown", "No such pending action.", 404);
    }
    const context = parseAssistantContext(body.context);
    // The choice this run will be bound to. Resolved and judged before the
    // run binds, so a refused submission spends nothing and the
    // submission the identity is taken over carries it.
    const current = currentAssistantChoices();
    if (!current.enabled) throw new ApiError("assistant_disabled", current.reason, 404);
    const choice = chooseForRequest(body.choice, current);
    const { runId, ...submission } = body;
    if (!assistantRuns.bind(runId, submission)) {
      return privateResponse(Response.json(assistantRuns.read(runId)));
    }
    claimedRun = runId;
    // What this run asked for, recorded before any provider request
    // exists: a run that fails before an answer still says it.
    assistantRuns.bindChoice(runId, choice);
    control = executionControl(runId, request.signal);
    const grounding = await loadGrounding(context, baseUrl, fetchImpl, control.signal);
    requireCurrentActor(actor);
    // The implicit decline: the client abandons the shown confirmation
    // by naming it. Unknown ids are ignored — abandoning an already-gone
    // action is not an error.
    if (typeof body.supersedes === "string") {
      const abandoned = pendingActions.peek(body.supersedes);
      if (abandoned?.runId) assistantRuns.release(abandoned.runId);
      pendingActions.supersede(body.supersedes);
    }

    const provider = createProvider({ model: choice.model, effort: choice.effort });
    if (!provider) {
      // Unreachable in practice (availability just checked enabled), but keep
      // the loop from ever running without a provider.
      throw new ApiError(
        "assistant_disabled",
        "The assistant is not enabled.",
        404,
      );
    }

    return privateResponse(runStream(
      runAssistant(
        provider,
        { message: body.message, history: parseHistory(body.history), context },
        // The page action policy binds with the context here.
        { baseUrl, fetchImpl, accountId: actor.account.id, signal: control.signal, grounding, runId, policy: policyFor(context) },
      ),
      runId,
      control,
    ));
  } catch (error) {
    control?.detach();
    if (claimedRun && control?.signal.aborted) { assistantRuns.record(claimedRun, { type: "done", reason: "interrupted" }); assistantRuns.finish(claimedRun); return authFailure(new EvaluationCancelled()); }
    if (claimedRun) assistantRuns.fail(claimedRun, error instanceof ApiError ? error : { code: "internal", message: ERROR_CATALOGUE.internal });
    return authFailure(error);
  }
}
