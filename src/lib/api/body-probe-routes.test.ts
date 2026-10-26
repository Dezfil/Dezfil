import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { getPictureState, requestPicture } from "@/lib/pictures/state";
import { bodyProbe } from "../../../scripts/body-probe.mjs";
vi.mock("@/lib/export/render-image", () => ({ renderMapImage: vi.fn(async () => {
  const png = Buffer.alloc(24); png.set([137,80,78,71,13,10,26,10]); png.writeUInt32BE(4096, 16); png.writeUInt32BE(4096, 20);
  return { png, abandoned: [] };
}) }));
type Handler = (req: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
const routes = Object.entries(import.meta.glob("../../app/api/**/route.ts")).map(([file, load]) => {
  const keys: string[] = [];
  const pattern = file.replace("../../app", "").replace("/route.ts", "").split("/").map(part => {
    if (part.startsWith("[")) { keys.push(part.slice(1, -1)); return "([^/]+)"; } return part;
  }).join("/");
  return { keys, pattern: new RegExp(`^${pattern}$`), load };
}).sort((a, b) => a.keys.length - b.keys.length);
it("drives every JSON operation with the served probe's requests and assertions", async () => {
  const dir = await mkdtemp(path.join(process.env.DEZFIL_DATA_DIR!, "body-probe-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir); vi.stubEnv("DEZFIL_AI_PROVIDER", "openai"); vi.stubEnv("OPENAI_API_KEY", "scripted-wire");
  closeMetadataDb(); resetQueryInstance(); const log = path.join(dir, "server.log"); await writeFile(log, "");
  const dispatch: typeof fetch = async (input, init) => {
    const request = socketRequest(new Request(input, init));
    const pathname = new URL(request.url).pathname;
    for (const route of routes) {
      const match = pathname.match(route.pattern); if (!match) continue;
      const handler = (await route.load() as Record<string, Handler>)[request.method];
      if (!handler) return Response.json({ error: { code: "method_not_allowed" } }, { status: 405 });
      return handler(request, { params: Promise.resolve(Object.fromEntries(route.keys.map((key, i) => [key, decodeURIComponent(match[i + 1])]))) });
    }
    throw new Error("Unexpected request " + request.url);
  };
  vi.stubGlobal("fetch", dispatch);
  const printed = vi.spyOn(console, "log").mockImplementation(() => {});
  const methods = new Set<string>();
  let workerSettled = false;
  try {
    const result = await bodyProbe("http://instance.test", { serverLog: log, runTransport: false,
      exchangeImpl: async (url: string, { method = "POST", headers = {}, chunks = [] }: { method?: string; headers?: Record<string, string>; chunks?: Iterable<Uint8Array> | AsyncIterable<Uint8Array> } = {}) => {
        methods.add(method);
        // The picture worker fails every map's picture whatever request is refused meanwhile.
        if (!workerSettled) {
          workerSettled = true;
          for (const { id } of metadataDb().prepare("SELECT id FROM maps").all() as { id: string }[]) if (!getPictureState(id)) requestPicture(id, "worker", Date.now());
          metadataDb().prepare("UPDATE map_pictures SET state = 'failed'").run();
        }
        if (headers["content-length"] === undefined) expect(headers["transfer-encoding"], `${method} ${new URL(url).pathname}: frame every unknown-length body`).toBe("chunked");
        else expect(headers["transfer-encoding"]).toBeUndefined();
        const iterator = Symbol.asyncIterator in chunks ? (chunks as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]() : (chunks as Iterable<Uint8Array>)[Symbol.iterator]();
        const stream = new ReadableStream({ async pull(controller) { const next = await iterator.next(); if (next.done) controller.close(); else controller.enqueue(next.value); } }, { highWaterMark: 0 });
        const response = await dispatch(url, { method, headers, body: stream, duplex: "half" } as RequestInit);
        const text = await response.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
        return { status: response.status, json, text, headers: Object.fromEntries(response.headers) };
      },
    });
    expect(result.operations).toBeGreaterThan(50); expect(result.checks).toBe(result.operations * 12);
    expect(methods.has("DELETE")).toBe(true);
    expect(result.mcp.rows).toBe(12_288);
    printed.mockRestore(); console.log(JSON.stringify({ label: "confirmed", scope: "route-level; renderer stubbed; no socket or framework copy", operations: result.operations, checks: result.checks, fixtures: result.fixtures, mcp: result.mcp }));
  } finally { closeMetadataDb(); resetQueryInstance(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); }
}, 180_000);
