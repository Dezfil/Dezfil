import { afterEach, expect, it, vi } from "vitest";
import { buildMcpFetchHandler } from "./handler";
afterEach(() => vi.restoreAllMocks());
it.each([false, true])("refuses MCP over-envelope bytes before SDK parsing (declared %s)", async declared => {
  const request = new Request("http://instance.test/api/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(declared ? { "content-length": "16777217" } : {}) }, body: declared ? "{}" : "{}" + " ".repeat(16_777_215) });
  const get = vi.spyOn(request, "body", "get");
  await expect(buildMcpFetchHandler().fetch(request)).rejects.toMatchObject({ status: 413, code: "request_body_too_large", message: "The request body exceeds the 16777216-byte limit." });
  if (declared) expect(get).not.toHaveBeenCalled();
});
it("cancels MCP at the crossing chunk without handing the request to the SDK", async () => {
  const read = vi.fn().mockResolvedValueOnce({ done: false, value: new Uint8Array(16_777_216) }).mockResolvedValueOnce({ done: false, value: new Uint8Array(1) });
  const cancel = vi.fn(), releaseLock = vi.fn();
  const request = new Request("http://instance.test/api/mcp", { method: "POST" });
  vi.spyOn(request, "body", "get").mockReturnValue({ getReader: () => ({ read, cancel, releaseLock }) } as unknown as ReadableStream<Uint8Array<ArrayBuffer>>);
  await expect(buildMcpFetchHandler().fetch(request)).rejects.toMatchObject({ status: 413 });
  expect(read).toHaveBeenCalledTimes(2); expect(cancel).toHaveBeenCalledOnce(); expect(releaseLock).toHaveBeenCalledOnce();
});
