// The tool harness's preload. The
// assistant loop reaches the instance's own API over loopback at the
// address src/lib/self-url.ts derives from PORT, and Next overwrites PORT
// with its listener at start, so the address cannot be pointed at the
// test's harness through the environment alone. Loaded through
// NODE_OPTIONS=--require into every process of the dev server before any
// module of the app, this wraps the global fetch so a server-side request
// to the instance's own listener (DEZFIL_E2E_LISTEN_PORT) goes to the
// harness instead (DEZFIL_E2E_SELF_PORT), which forwards it and counts
// it. Only server-side requests pass here: the browser's traffic never
// runs through the server's fetch. While no harness listens (a suite that
// counts nothing), a refused connection falls back to the listener itself,
// so the instance behaves as a plain one; a suite that counts checks its
// wiring with a turn that must reach the harness. Test-owned; nothing in
// the product reads these variables.
const listen = process.env.DEZFIL_E2E_LISTEN_PORT;
const self = process.env.DEZFIL_E2E_SELF_PORT;
if (listen && self && typeof globalThis.fetch === "function") {
  const original = globalThis.fetch;
  const own = new RegExp(`^http://(127\\.0\\.0\\.1|localhost|\\[::1\\]):${listen}(?=/|$)`);
  const refused = (error) => {
    let cause = error && error.cause;
    for (let depth = 0; cause && depth < 4; depth += 1) {
      if (cause.code === "ECONNREFUSED") return true;
      if (Array.isArray(cause.errors) && cause.errors.some((e) => e && e.code === "ECONNREFUSED")) return true;
      cause = cause.cause;
    }
    return false;
  };
  globalThis.fetch = async function fetchThroughHarness(input, init) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input && typeof input.url === "string" ? input.url : null;
    // Only the app's API goes through the harness; the dev server's own
    // sockets (its HMR endpoint) stay where they are.
    if (!url || !own.test(url) || /^http:\/\/[^/]+\/_next\//.test(url)) return original.call(this, input, init);
    const rewritten = url.replace(own, `http://127.0.0.1:${self}`);
    const isRequest = typeof input === "object" && !(input instanceof URL) && input !== null;
    // A Request's body can be read once: keep a clone for the fallback.
    const fallback = isRequest ? input.clone() : input;
    try {
      return await original.call(this, isRequest ? new Request(rewritten, input) : rewritten, init);
    } catch (error) {
      if (!refused(error)) throw error;
      return original.call(this, fallback, init);
    }
  };
}
