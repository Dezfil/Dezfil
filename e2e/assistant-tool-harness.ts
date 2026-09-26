// The test-owned tool harness for the browser gate (the shape
// departure-http.test.ts uses for its route cases, moved to where a real
// instance runs). The assistant loop dispatches its product calls to the
// instance's own API over loopback (src/lib/self-url.ts), where a browser
// cannot see them. Booting the instance with the preload
// `assistant-self-port.cjs`, which sends the server's own loopback
// requests here instead, puts every one of those dispatches through this
// harness: counted server-side, held at a barrier when a case asks, and
// forwarded unchanged to the instance. The browser drives the instance
// directly, so nothing of the browser's own traffic is counted. A departed
// dispatch (the loop's abort on Stop) closes the upstream request too, so
// a cancelled read still cancels.
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export const TOOL_HARNESS_PORT = 3303;
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface HarnessRequest { method: string; path: string; at: number }
export interface HarnessBarrier {
  key: string;
  matches: (method: string, path: string) => boolean;
  /** On release, forward the request but destroy the loop's connection
   * before any response reaches it: the mutation happens, its outcome is
   * lost to the loop (the shape departure-http.test.ts's loseMutation has). */
  lose?: boolean;
}

export function assistantToolHarness(targetOrigin: string) {
  const target = new URL(targetOrigin);
  const dispatches: HarnessRequest[] = [];
  const reads: HarnessRequest[] = [];
  const barriers: HarnessBarrier[] = [];
  const waiting = new Map<string, () => void>();
  const arrived = new Set<string>();
  const hold = (key: string) => new Promise<void>((resolve) => { arrived.add(key); waiting.set(key, () => { waiting.delete(key); resolve(); }); });

  async function forward(incoming: IncomingMessage, outgoing: ServerResponse) {
    const method = incoming.method ?? "GET";
    const path = incoming.url ?? "/";
    const seen = { method, path, at: Date.now() };
    (MUTATING.has(method) ? dispatches : reads).push(seen);
    const barrier = barriers.find((b) => b.matches(method, path));
    if (barrier) {
      barriers.splice(barriers.indexOf(barrier), 1);
      await hold(barrier.key);
      // The loop departed while the request was held: nothing to forward.
      if (outgoing.destroyed) return;
    }
    const headers = { ...incoming.headers, host: target.host };
    let departed = false;
    const upstream = httpRequest({ hostname: target.hostname, port: target.port, method, path, headers }, (response) => {
      if (barrier?.lose) { response.resume(); response.on("end", () => { departed = true; outgoing.destroy(); }); return; }
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    });
    upstream.on("error", (error) => { if (!departed) console.error(`[tool harness] upstream ${method} ${path} failed: ${error.message}`); if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
    // The loop's departure: an aborted dispatch must abort upstream too. The
    // response's close, not the request's, which fires once the body is read.
    outgoing.on("close", () => { if (!outgoing.writableFinished) { departed = true; upstream.destroy(); } });
    incoming.pipe(upstream);
  }

  let server: Server | null = null;
  return {
    port: TOOL_HARNESS_PORT,
    dispatches,
    reads,
    /** Hold the next request matching the test at the named key until released; with `lose`, forward it on release and lose its response. */
    barrier(key: string, matches: (method: string, path: string) => boolean, options: { lose?: boolean } = {}) { barriers.push({ key, matches, lose: options.lose }); },
    /** Resolves once a dispatch is waiting at the key. */
    async reached(key: string, timeoutMs = 15_000) {
      const started = Date.now();
      while (!waiting.has(key)) {
        if (Date.now() - started > timeoutMs) throw new Error(`No dispatch reached the harness barrier ${key}; held: ${[...waiting.keys()].join(", ") || "none"}`);
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    },
    release(key: string) {
      const release = waiting.get(key);
      if (!release) throw new Error(`The harness is not holding ${key}`);
      release();
    },
    /** Whether a barrier with this key was ever reached (for a case that expects it never was). */
    everReached(key: string) { return arrived.has(key); },
    reset() { dispatches.length = 0; reads.length = 0; barriers.length = 0; arrived.clear(); for (const release of waiting.values()) release(); },
    async start() {
      server = createServer((incoming, outgoing) => { void forward(incoming, outgoing); });
      await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(TOOL_HARNESS_PORT, "127.0.0.1", resolve); });
    },
    async stop() {
      for (const release of waiting.values()) release();
      if (!server) return;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    },
  };
}

/** The instance's own base URL from the runner's target: the harness forwards there. */
export function harnessTarget(): string {
  const base = process.env.DEZFIL_BASE_URL ?? "http://localhost:3000";
  const url = new URL(base);
  return `http://127.0.0.1:${url.port || "80"}`;
}
