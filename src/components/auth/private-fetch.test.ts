import { expect, it, vi } from "vitest";
import { privateFetch } from "./private-fetch";

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const origin = "http://instance.test";
it("binds same-origin requests to the document account and preserves explicit cancellation", async () => {
  const lifetime = new AbortController(), caller = new AbortController();
  const transport = vi.fn<typeof fetch>(async () => Response.json({ rows: ["own"] }));
  const fetch = privateFetch("alice", origin, transport, lifetime.signal, vi.fn());
  const response = await fetch(new Request(origin + "/api/query", { headers: { "x-dezfil-account": "bob", "content-type": "application/json" } }), { signal: caller.signal });
  const init = transport.mock.calls[0][1]!;
  expect(new Headers(init.headers).get("x-dezfil-account")).toBe("alice");
  expect(new Headers(init.headers).get("content-type")).toBe("application/json");
  expect(init.cache).toBe("no-store");
  expect(await response.json()).toEqual({ rows: ["own"] });
  caller.abort(); expect(init.signal?.aborted).toBe(true);
  await fetch("https://basemap.test/tile", { credentials: "omit" });
  expect(transport.mock.calls[1]).toEqual(["https://basemap.test/tile", { credentials: "omit" }]);
});
it("drops late headers even when the transport ignores cancellation and prevents later dispatch", async () => {
  const lifetime = new AbortController(), pending = deferred<Response>();
  const transport = vi.fn<typeof fetch>(() => pending.promise);
  const fetch = privateFetch("alice", origin, transport, lifetime.signal, vi.fn());
  const result = fetch("/api/projects");
  lifetime.abort(); pending.resolve(Response.json([{ name: "private sentinel" }]));
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  await expect(fetch("/api/maps", { method: "POST" })).rejects.toMatchObject({ name: "AbortError" });
  expect(transport).toHaveBeenCalledTimes(1);
});
it.each(["json", "text", "blob", "arrayBuffer"] as const)("drops a late %s body, including retained export tickets", async method => {
  const lifetime = new AbortController(), chunk = deferred<Uint8Array>();
  const response = new Response(new ReadableStream({ async pull(controller) { controller.enqueue(await chunk.promise); controller.close(); } }));
  const fetch = privateFetch("alice", origin, vi.fn(async () => response), lifetime.signal, vi.fn());
  const held = await fetch("/api/query/export");
  const result = held[method]();
  lifetime.abort(); chunk.resolve(new TextEncoder().encode('{"ticket":"private sentinel"}'));
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
});
it("fences assistant stream chunks and clones after the account changes", async () => {
  const lifetime = new AbortController(); let controller!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream({ start(value) { controller = value; } }));
  const fetch = privateFetch("alice", origin, vi.fn(async () => response), lifetime.signal, vi.fn());
  const held = await fetch("/api/assistant"), clone = held.clone(), reader = held.body!.getReader();
  controller.enqueue(new TextEncoder().encode("data: first\n\n"));
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("first");
  const next = reader.read(); lifetime.abort(); controller.enqueue(new TextEncoder().encode("private sentinel"));
  await expect(next).rejects.toMatchObject({ name: "AbortError" });
  await expect(clone.text()).rejects.toMatchObject({ name: "AbortError" });
  expect(() => held.clone()).toThrow(expect.objectContaining({ name: "AbortError" }));
  controller.close();
});
it("retires the document on an authentication refusal before exposing its body", async () => {
  const lifetime = new AbortController(), rejected = vi.fn(() => lifetime.abort());
  const fetch = privateFetch("alice", origin, vi.fn(async () => Response.json({ error: { code: "authentication_required" } }, { status: 401 })), lifetime.signal, rejected);
  await expect(fetch("/api/maps")).rejects.toMatchObject({ name: "AbortError" });
  expect(rejected).toHaveBeenCalledOnce();
});
