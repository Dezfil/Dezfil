/** Fence both response headers and body consumption, including assistant
 * streams and export tickets. Aborting alone does not fence an already-read
 * body or a transport that settles after cancellation. */
function guardedResponse(response: Response, assertCurrent: () => void): Response {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const nullBodyStatus = response.status === 204 || response.status === 205 || response.status === 304;
  const body = !nullBodyStatus && response.body ? new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        assertCurrent();
        reader ??= response.body!.getReader();
        const item = await reader.read();
        assertCurrent();
        if (item.done) controller.close(); else controller.enqueue(item.value);
      } catch (error) { controller.error(error); void reader?.cancel().catch(() => {}); }
    },
    cancel(reason) { return reader ? reader.cancel(reason) : response.body!.cancel(reason); },
  }, { highWaterMark: 0 }) : null;
  const readable = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  return new Proxy(response, {
    get(target, key) {
      if (key === "clone") return () => { assertCurrent(); return guardedResponse(target.clone(), assertCurrent); };
      if (key === "body") return readable.body;
      if (key === "bodyUsed") return readable.bodyUsed;
      if (["json", "text", "blob", "arrayBuffer", "bytes", "formData"].includes(String(key))) return async () => {
        assertCurrent();
        const result = await (Reflect.get(readable, key, readable) as () => Promise<unknown>).call(readable);
        assertCurrent(); return result;
      };
      return Reflect.get(target, key, target);
    },
  });
}

export function privateFetch(accountId: string, origin: string, transport: typeof fetch, lifetime: AbortSignal, rejected: () => void): typeof fetch {
  const assertCurrent = () => { if (lifetime.aborted) throw new DOMException("The account changed.", "AbortError"); };
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), origin);
    // Remote basemaps retain their own request and credential policy.
    if (url.origin !== origin) return transport(input, init);
    assertCurrent();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set("x-dezfil-account", accountId);
    const signal = AbortSignal.any([lifetime, ...(init?.signal ? [init.signal] : input instanceof Request ? [input.signal] : [])]);
    const response = await transport(input, { ...init, headers, signal, cache: "no-store" });
    assertCurrent();
    if (response.status === 401) { rejected(); assertCurrent(); throw new DOMException("The session ended.", "AbortError"); }
    return guardedResponse(response, assertCurrent);
  };
}
