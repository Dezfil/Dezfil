import { afterEach, expect, it, vi } from "vitest";
import { boundedBodyText } from "./bounded-body";
afterEach(() => vi.restoreAllMocks());
it.each([undefined, "2", "1", "16777216"])("allocates for arriving bytes, not the large ceiling (length %s)", async declared => {
  const request = new Request("http://instance.test", { method: "POST", headers: declared ? { "content-length": declared } : {}, body: "{}" });
  const allocations: number[] = [], Native = Uint8Array;
  vi.stubGlobal("Uint8Array", new Proxy(Native, { construct(target, args) {
    if (typeof args[0] === "number") allocations.push(args[0]);
    return Reflect.construct(target, args);
  } }));
  try {
    expect(await boundedBodyText(request, 16_777_216)).toBe("{}");
    expect(allocations.length).toBeGreaterThan(0);
    expect(Math.max(...allocations)).toBeLessThanOrEqual(4096);
  } finally { vi.unstubAllGlobals(); }
});
it("owns copied bytes even when a producer reuses a much larger backing store", async () => {
  const backing = new Uint8Array(1024 * 1024); backing.set(new TextEncoder().encode("{}"));
  let pulls = 0;
  const request = new Request("http://instance.test", { method: "POST" });
  vi.spyOn(request, "body", "get").mockReturnValue({ getReader: () => ({
    read: async () => ++pulls === 1 ? { done: false, value: backing.subarray(0, 2) } : (backing.fill(0), { done: true }),
    releaseLock() {},
  }) } as unknown as ReadableStream<Uint8Array<ArrayBuffer>>);
  expect(await boundedBodyText(request, 16_777_216)).toBe("{}");
});
it("counts UTF-8 and escape bytes at all general-tier boundaries regardless of declaration", async () => {
  for (const declared of [false, true]) for (const text of ['{"value":"雪"}', '{"value":"\\u96ea"}']) for (const bytes of [16_777_215, 16_777_216, 16_777_217]) {
    const body = text + " ".repeat(bytes - Buffer.byteLength(text));
    const request = new Request("http://instance.test", { method: "POST", body, headers: { "content-type": "text/plain", ...(declared ? { "content-length": String(bytes) } : {}) } });
    if (bytes > 16_777_216) await expect(boundedBodyText(request, 16_777_216)).rejects.toMatchObject({ status: 413 });
    else expect(JSON.parse(await boundedBodyText(request, 16_777_216))).toEqual({ value: "雪" });
  }
});


it.each([65_536, 16_777_216])("allocates no payload storage while a declared %s-byte body has sent nothing", async limit => {
  const request = new Request("http://instance.test", { method: "POST", headers: { "content-length": String(limit) } });
  let finish!: (chunk: ReadableStreamReadResult<Uint8Array>) => void;
  const read = vi.fn(() => new Promise<ReadableStreamReadResult<Uint8Array>>(resolve => { finish = resolve; }));
  const releaseLock = vi.fn();
  vi.spyOn(request, "body", "get").mockReturnValue({ getReader: () => ({ read, releaseLock }) } as unknown as ReadableStream<Uint8Array<ArrayBuffer>>);
  const allocations: number[] = [], Native = Uint8Array;
  vi.stubGlobal("Uint8Array", new Proxy(Native, { construct(target, args) {
    if (typeof args[0] === "number") allocations.push(args[0]);
    return Reflect.construct(target, args);
  } }));
  const reading = boundedBodyText(request, limit);
  try {
    expect(read).toHaveBeenCalledOnce();
    expect(allocations.filter(bytes => bytes > 0)).toEqual([]);
  } finally {
    finish({ done: true, value: undefined });
    expect(await reading).toBe("");
    vi.unstubAllGlobals();
  }
  expect(releaseLock).toHaveBeenCalledOnce();
});
