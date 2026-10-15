import { afterEach, expect, it, vi } from "vitest";
import { xhrTransport } from "./upload-transport";
import { createUploadQueue } from "./upload-queue";

class UploadRequest {
  static sent: UploadRequest[] = [];
  upload = {}; status = 0; responseText = "";
  onload?: () => void; onerror?: () => void;
  open = vi.fn(); send() { UploadRequest.sent.push(this); }
  answer(status: number, body: unknown) { this.status = status; this.responseText = typeof body === "string" ? body : JSON.stringify(body); this.onload?.(); }
}
afterEach(() => { vi.unstubAllGlobals(); UploadRequest.sent = []; });
function upload() {
  vi.stubGlobal("XMLHttpRequest", UploadRequest);
  const handlers = { progress: vi.fn(), refused: vi.fn(), lost: vi.fn(), imported: vi.fn() };
  xhrTransport(new File(["lon,lat\n1,2\n"], "points.csv"), handlers, { projectId: null });
  return { handlers, request: UploadRequest.sent.at(-1)! };
}
it.each(["upload_stalled", "data_processing_timeout", "upload_too_large"])("shows the application's %s sentence", code => {
  const { handlers, request } = upload();
  request.answer(code === "upload_too_large" ? 413 : 408, { error: { code, message: "The admitted upload limit was reached." } });
  expect(handlers.refused).toHaveBeenCalledExactlyOnceWith("The admitted upload limit was reached."); expect(handlers.lost).not.toHaveBeenCalled();
});
it.each(["<html>Gateway timeout</html>", { error: "proxy timeout" }, { message: "Gateway timeout" }, { error: { code: "upstream_timeout", message: "Gateway timeout" } }])("keeps an intermediary answer as a transport loss: %j", body => {
  const { handlers, request } = upload(); request.answer(504, body);
  expect(handlers.lost).toHaveBeenCalledOnce(); expect(handlers.refused).not.toHaveBeenCalled();
});
it("keeps a disconnected response as a transport loss", () => {
  const { handlers, request } = upload(); request.onerror?.();
  expect(handlers.lost).toHaveBeenCalledOnce(); expect(handlers.refused).not.toHaveBeenCalled();
});
it("settles a typed refusal and imports the next file", () => {
  vi.stubGlobal("XMLHttpRequest", UploadRequest);
  const queue = createUploadQueue(xhrTransport);
  queue.add([new File(["x"], "first.csv"), new File(["y"], "second.csv")]);
  UploadRequest.sent[0].answer(408, { error: { code: "upload_stalled", message: "The upload sent no body bytes for 60 s. Retry the upload." } });
  UploadRequest.sent[1].answer(201, { id: "second", name: "second" });
  const entries = queue.getSnapshot().entries;
  expect(entries.map(entry => entry.state)).toEqual(["failed", "imported"]);
  expect(entries[0].error).toBe("The upload sent no body bytes for 60 s. Retry the upload.");
});
