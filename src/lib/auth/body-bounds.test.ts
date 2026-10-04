import { afterEach, expect, it, vi } from "vitest";
import { authBody } from "./http";
import { invitationBody, accessBody } from "./admin-http";
const limit = 65_536;
afterEach(() => vi.restoreAllMocks());
const readers = [
  (r: Request) => authBody(r, ["name"], []),
  invitationBody, accessBody,
];
const values = [{ name: "雪" }, { name: "雪", email: "a@b.test" }, { status: "active" }];
it.each(readers.map((read, index) => ({ read, index })))("bounds account helper $index in wire bytes before parsing", async ({ read, index }) => {
  for (const declared of [false, true]) for (const escaped of [false, true]) for (const bytes of [limit - 1, limit, limit + 1]) {
    const json = JSON.stringify(values[index]).replace(/雪/g, escaped ? "\\u96ea" : "雪");
    const body = json + " ".repeat(bytes - Buffer.byteLength(json));
    const request = new Request("http://instance.test", { method: "POST", body, headers: { "content-type": "application/json", ...(declared ? { "content-length": String(bytes) } : {}) } });
    if (bytes > limit) await expect(read(request)).rejects.toMatchObject({ status: 413, code: "request_body_too_large", message: "The request body exceeds the 65536-byte limit." });
    else await expect(read(request)).resolves.toEqual(values[index]);
  }
});
it.each(readers)("refuses declared excess without a body read", async read => {
  const request = new Request("http://instance.test", { method: "POST", body: "{}", headers: { "content-type": "application/json", "content-length": String(limit + 1) } });
  const get = vi.spyOn(request, "body", "get");
  await expect(read(request)).rejects.toMatchObject({ status: 413 });
  expect(get).not.toHaveBeenCalled();
});
it.each(readers)("cancels the crossing chunk without another pull or a parse default", async read => {
  const chunks = [new Uint8Array(limit), new Uint8Array(1), new Uint8Array(1)];
  const pull = vi.fn(async () => ({ done: false, value: chunks.shift()! })), cancel = vi.fn(), releaseLock = vi.fn();
  const request = new Request("http://instance.test", { method: "POST", headers: { "content-type": "application/json", "content-length": "1" } });
  vi.spyOn(request, "body", "get").mockReturnValue({ getReader: () => ({ read: pull, cancel, releaseLock }) } as unknown as ReadableStream<Uint8Array<ArrayBuffer>>);
  await expect(read(request)).rejects.toMatchObject({ status: 413 });
  expect(pull).toHaveBeenCalledTimes(2); expect(cancel).toHaveBeenCalledOnce(); expect(releaseLock).toHaveBeenCalledOnce();
});
it("keeps optional fields and missing-body refusal", async () => {
  await expect(authBody(new Request("http://instance.test", { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" }), ["name"], [])).resolves.toEqual({});
  await expect(authBody(new Request("http://instance.test", { method: "PATCH", headers: { "content-type": "application/json" } }), ["name"], [])).rejects.toMatchObject({ status: 400 });
});
