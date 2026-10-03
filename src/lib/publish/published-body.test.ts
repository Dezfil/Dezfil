import { afterEach, expect, it, vi } from "vitest";
import * as publication from "./publication-scope";
import { POST as widgets } from "@/app/api/published/[token]/widget-values/route";
import { POST as render } from "@/app/api/published/[token]/render/[layerId]/route";
import { POST as extent } from "@/app/api/published/[token]/extent/[layerId]/route";

const limit = 65_536;
const handlers = [widgets, render, extent];
afterEach(() => vi.restoreAllMocks());

it.each(handlers)("refuses declared excess without acquiring or reading the body", async handler => {
  const request = new Request("http://instance.test/api/published/fixture/" + (handler === widgets ? "widget-values" : handler === render ? "render/fixture" : "extent/fixture"), {
    method: "POST", headers: { "content-length": String(limit + 1) }, body: "{}",
  });
  const body = vi.spyOn(request, "body", "get");
  const resolve = vi.spyOn(publication, "resolvePublication");
  const response = await handler(request, { params: Promise.resolve({ token: "fixture", layerId: "fixture" }) });
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({ error: { code: "request_body_too_large", message: "The request body exceeds the 65536-byte limit." } });
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(body).not.toHaveBeenCalled();
  expect(resolve).not.toHaveBeenCalled();
});

it.each([undefined, "1", "invalid"])("cancels at the crossing chunk with at most the tier retained (%s)", async declared => {
  const { publishedJsonBody } = await import("./published-body");
  const crossing = new Uint8Array(4 * 1024 * 1024);
  const chunks = [new TextEncoder().encode(" ".repeat(limit)), crossing, new Uint8Array(1)];
  const read = vi.fn(async () => ({ done: false, value: chunks.shift()! }));
  const cancel = vi.fn(async () => {}), releaseLock = vi.fn();
  const request = new Request("http://instance.test", { method: "POST", headers: declared ? { "content-length": declared } : {} });
  vi.spyOn(request, "body", "get").mockReturnValue({ getReader: () => ({ read, cancel, releaseLock }) } as unknown as ReadableStream<Uint8Array<ArrayBuffer>>);
  const copied: { bytes: number; capacity: number }[] = [];
  const original = Uint8Array.prototype.set;
  vi.spyOn(Uint8Array.prototype, "set").mockImplementation(function (this: Uint8Array, source, offset) {
    copied.push({ bytes: source.length, capacity: this.buffer.byteLength });
    return original.call(this, source, offset);
  });
  await expect(publishedJsonBody(request)).rejects.toMatchObject({ status: 413, code: "request_body_too_large" });
  expect(read).toHaveBeenCalledTimes(2);
  expect(cancel).toHaveBeenCalledOnce();
  expect(releaseLock).toHaveBeenCalledOnce();
  expect(chunks).toHaveLength(1);
  expect(copied).toEqual([{ bytes: limit, capacity: limit }]);
});

it("keeps exact wire-byte admission, UTF-8, escaping and empty-body semantics", async () => {
  const { publishedJsonBody } = await import("./published-body");
  for (const bytes of [limit - 1, limit, limit + 1]) for (const value of ["雪", "\\u96ea"]) {
    const json = `{"value":"${value}"}`;
    const text = json + " ".repeat(bytes - Buffer.byteLength(json));
    const request = new Request("http://instance.test", { method: "POST", headers: { "content-type": "text/plain" }, body: text });
    if (bytes > limit) await expect(publishedJsonBody(request)).rejects.toMatchObject({ status: 413 });
    else await expect(publishedJsonBody(request)).resolves.toEqual({ value: "雪" });
  }
  await expect(publishedJsonBody(new Request("http://instance.test", { method: "POST" }))).resolves.toEqual({});
  for (const body of [" ", "{", "[broken]"]) {
    await expect(publishedJsonBody(new Request("http://instance.test", { method: "POST", body }))).rejects.toMatchObject({ status: 400, message: "Expected a JSON body." });
  }
});
