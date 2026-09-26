// Scripted vendor wire, outside the app. Run the isolated app with
// OPENAI_BASE_URL=http://127.0.0.1:3202/v1 and a dummy OPENAI_API_KEY.
// No product endpoint or production provider selection is added.
//
// Since (task 1) a reply can be delivered in named deltas and held at
// acknowledged release points: before its first delta, after each delta,
// and before its completion. The fixture waits at a point until the test
// releases it, so a beat is released only after the test has observed the
// rendered state; an elapsed sleep establishes no sequence. Points are
// keyed by the reply's ordinal since the last reset and the point's name.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

export interface ScriptedReply {
  text?: string;
  /** The text as separate deltas, in order; `text` need not be given. */
  chunks?: string[];
  calls?: { name: string; args: Record<string, unknown> }[];
  /** Hold the completion this long after the text delta, so a reply can
   * be observed mid-stream (a block still streaming carries no action
   * until it completes). */
  holdMs?: number;
  /** Acknowledged release points: `first` waits before the
   * first delta, `chunks` after every delta but the last, `complete`
   * before the completion event. */
  hold?: { first?: boolean; chunks?: boolean; complete?: boolean };
}

/** The point a held reply is waiting at: `<reply ordinal>:first`,
 * `<reply ordinal>:chunk:<n>` (after delta n, zero-based), `<reply ordinal>:complete`. */
export type ReleasePoint = `${number}:first` | `${number}:chunk:${number}` | `${number}:complete`;

export function assistantProviderFixture() {
  const replies: ScriptedReply[] = [];
  const captures: { input: { role?: string; content?: unknown }[]; model: string }[] = [];
  const waiting = new Map<string, () => void>();
  const hold = (key: string) => new Promise<void>((resolve) => { waiting.set(key, () => { waiting.delete(key); resolve(); }); });
  const server = createServer(async (req, res) => {
    if (req.url !== "/v1/responses" || req.method !== "POST") { res.writeHead(404).end(); return; }
    let body = ""; for await (const chunk of req) body += chunk;
    const ordinal = captures.length;
    captures.push(JSON.parse(body));
    const next = replies.shift();
    if (!next) { res.writeHead(500).end("No scripted provider reply remains"); return; }
    const chunks = next.chunks ?? (next.text ? [next.text] : []);
    const text = chunks.join("");
    const output: unknown[] = [];
    if (text) output.push({ type: "message", id: randomUUID(), role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
    for (const call of next.calls ?? []) output.push({ type: "function_call", id: randomUUID(), call_id: randomUUID(), name: call.name, arguments: JSON.stringify(call.args), status: "completed" });
    res.writeHead(200, { "content-type": "text/event-stream" });
    // Headers out before any hold, so the adapter's request has been answered
    // and only the events wait.
    res.flushHeaders();
    if (next.hold?.first) await hold(`${ordinal}:first`);
    for (const [index, delta] of chunks.entries()) {
      res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta })}\n\n`);
      if (next.hold?.chunks && index < chunks.length - 1) await hold(`${ordinal}:chunk:${index}`);
    }
    if (next.hold?.complete) await hold(`${ordinal}:complete`);
    const complete = () => res.end(`data: ${JSON.stringify({ type: "response.completed", response: { id: randomUUID(), model: "scripted-model", status: "completed", output } })}\n\n`);
    if (next.holdMs) setTimeout(complete, next.holdMs); else complete();
  });
  return { captures, replies,
    reset() { captures.length = 0; replies.length = 0; for (const release of waiting.values()) release(); },
    /** Resolves once the fixture is waiting at the point. */
    async reached(point: ReleasePoint, timeoutMs = 15_000) {
      const started = Date.now();
      while (!waiting.has(point)) {
        if (Date.now() - started > timeoutMs) throw new Error(`The provider fixture never reached ${point}; waiting at: ${[...waiting.keys()].join(", ") || "nothing"}`);
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    },
    /** Let a held reply continue past the point. */
    release(point: ReleasePoint) {
      const release = waiting.get(point);
      if (!release) throw new Error(`The provider fixture is not waiting at ${point}`);
      release();
    },
    /** The points currently held. */
    held(): string[] { return [...waiting.keys()]; },
    async start() { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(3202, "127.0.0.1", resolve); }); },
    async stop() { for (const release of waiting.values()) release(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}
