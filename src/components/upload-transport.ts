import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import type { DataTable } from "./api";
import type { SkippedMember } from "./skipped-members";
import type { UploadTransport } from "./upload-queue";

/** The real transport: XHR rather than fetch so byte progress is real —
 * multi-GB files deserve an honest progress bar. A network error is
 * reported as lost, never as a refusal: the answer, not the import, is
 * what provably went missing. */
export const xhrTransport: UploadTransport = (file, handlers, context) => {
  const form = new FormData();
  form.append("file", file);
  const xhr = new XMLHttpRequest();
  // The batch-captured import context: the documented upload road's
  // project parameter files every created table.
  xhr.open(
    "POST",
    context.projectId === null
      ? "/api/tables"
      : `/api/tables?project=${encodeURIComponent(context.projectId)}`,
  );
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) handlers.progress(e.loaded / e.total);
  };
  xhr.onerror = () => handlers.lost();
  xhr.onload = () => {
    try {
      const body = JSON.parse(xhr.responseText);
      if (xhr.status >= 400) {
        if (typeof body?.error?.code === "string" && Object.hasOwn(ERROR_CATALOGUE, body.error.code) && typeof body.error.message === "string") {
          handlers.refused(body.error.message);
        } else handlers.lost();
      } else {
        // Container formats answer with every table they created; each
        // file's answer bubbles as it lands.
        const answer = body as DataTable & {
          tables?: DataTable[];
          skipped?: SkippedMember[];
        };
        handlers.imported(answer.tables ?? [answer], answer.skipped ?? []);
      }
    } catch {
      handlers.lost();
    }
  };
  xhr.send(form);
};
