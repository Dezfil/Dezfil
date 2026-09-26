import type { ExecutionControl } from "./execution-control";
import { ApiError } from "@/lib/api/errors";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import type { AssistantEvent } from "./loop";
import { assistantRuns } from "./runs";

/** The producer records independently of whether the execution stream is read. */
export function runStream(events: AsyncGenerator<AssistantEvent>, runId?: string, control?: ExecutionControl): Response {
  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: AssistantEvent) => {
        if (runId) assistantRuns.record(runId, event);
        if (!closed) controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };
      try { for await (const event of events) emit(event); }
      catch (error) {
        if (!(error instanceof ApiError) && !control?.signal.aborted) console.error("[assistant] unexpected stream error:", error);
        if (control?.signal.aborted) emit({ type: "done", reason: "interrupted" });
        else emit({ type: "error", code: error instanceof ApiError ? error.code : "internal", message: error instanceof ApiError ? error.message : ERROR_CATALOGUE.internal });
      } finally {
        if (runId) assistantRuns.finish(runId);
        control?.detach();
        if (!closed) { closed = true; controller.close(); }
      }
    },
    cancel() { closed = true; control?.depart(); },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
