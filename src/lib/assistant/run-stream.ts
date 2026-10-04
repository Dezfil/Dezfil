import { beginAssistantWork } from "./retained-work";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { AuthError } from "@/lib/auth/errors";
import type { ExecutionControl } from "./execution-control";
import { ApiError } from "@/lib/api/errors";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import type { AssistantEvent } from "./loop";
import { assistantRuns } from "./runs";

/** The producer records independently of whether the execution stream is read. */
export function runStream(scope: AccountScope, events: AsyncGenerator<AssistantEvent>, runId?: string, control?: ExecutionControl): Response {
  requireAccountScope(scope);
  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const work = beginAssistantWork(scope, () => {
        if (!closed) { closed = true; controller.error(new AuthError("authentication_required", "Sign in to continue.", 401)); }
        control?.depart();
      });
      const emit = (event: AssistantEvent) => {
        requireAccountScope(scope);
        if (runId) assistantRuns.record(scope, runId, event);
        if (!closed) controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };
      try { for await (const event of events) emit(event); }
      catch (error) {
        if (error instanceof AuthError) {
          if (runId) assistantRuns.settleInactive(runId);
          if (!closed) controller.enqueue(encoder.encode(JSON.stringify({ type: "error", code: error.code, message: error.message }) + "\n"));
        } else {
          if (!(error instanceof ApiError) && !control?.signal.aborted) console.error("[assistant] unexpected stream error:", error);
          if (control?.signal.aborted) emit({ type: "done", reason: "interrupted" });
          else emit({ type: "error", code: error instanceof ApiError ? error.code : "internal", message: error instanceof ApiError ? error.message : ERROR_CATALOGUE.internal });
        }
      } finally {
        if (runId && !assistantRuns.settleInactive(runId)) assistantRuns.finish(scope, runId);
        control?.detach();
        if (!closed) { closed = true; controller.close(); }
        work.finish();
      }
    },
    cancel() { closed = true; control?.depart(); },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
