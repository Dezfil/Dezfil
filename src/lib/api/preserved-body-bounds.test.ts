import { afterEach, expect, it, vi } from "vitest";
import { jsonBody, optionalJsonBody } from "@/lib/operations/recipe-api";
import { readSubmission } from "@/lib/assistant/recovery-data";
import { geometryRequest } from "@/lib/geometry/request";
import { authBody } from "@/lib/auth/http";
afterEach(() => vi.restoreAllMocks());
const readers = [
  { read: jsonBody, limit: 16_777_216, code: "request_body_too_large", message: "The workflow request body exceeds the 16777216-byte limit." },
  { read: optionalJsonBody, limit: 16_777_216, code: "request_body_too_large", message: "The workflow request body exceeds the 16777216-byte limit." },
  { read: readSubmission, limit: 131_072, code: "assistant_submission_too_large", message: "" },
];
it.each(readers)("preserves $code at $limit and owns producer storage", async ({ read, limit, code, message }) => {
  for (const declared of [true, false]) for (const bytes of [limit - 1, limit, limit + 1]) {
    const json = '{"value":"雪\\u96ea"}', body = json + " ".repeat(bytes - Buffer.byteLength(json));
    const req = new Request("http://instance.test", { method: "POST", body, headers: { "content-type": "text/plain", ...(declared ? { "content-length": String(bytes) } : {}) } });
    const get = vi.spyOn(req, "body", "get");
    if (bytes > limit) { await expect(read(req)).rejects.toMatchObject({ status: 413, code, ...(message ? { message } : {}) }); if (declared) expect(get).not.toHaveBeenCalled(); }
    else await expect(read(req)).resolves.toEqual({ value: "雪雪" });
  }
  const backing = new Uint8Array(2 * limit); backing.set(new TextEncoder().encode("{}")); let pulls = 0;
  const req = new Request("http://instance.test", { method: "POST" });
  vi.spyOn(req, "body", "get").mockReturnValue({ getReader: () => ({ read: async () => ++pulls === 1 ? { value: backing.subarray(0, 2), done: false } : (backing.fill(0), { done: true }), releaseLock() {} }) } as unknown as ReadableStream<Uint8Array<ArrayBuffer>>);
  await expect(read(req)).resolves.toEqual({});
});
it("keeps required and optional workflow emptiness distinct", async () => {
  const empty = () => new Request("http://instance.test", { method: "POST" });
  await expect(jsonBody(empty())).rejects.toMatchObject({ status: 400, message: "The request body must be a JSON object." });
  await expect(optionalJsonBody(empty())).resolves.toEqual({});
  await expect(readSubmission(empty())).rejects.toMatchObject({ status: 400, message: "Expected a JSON object body." });
});
it("bounds geometry helper and auth bytes before their format refusals", async () => {
  for (const [read, limit] of [[geometryRequest, 16_777_216], [(req: Request) => authBody(req, []), 65_536]] as const) {
    await expect(read(new Request("http://instance.test", { method: "POST", body: "{", headers: { "content-type": "text/plain", "content-length": String(limit + 1) } }))).rejects.toMatchObject({ status: 413, code: "request_body_too_large" });
  }
});
