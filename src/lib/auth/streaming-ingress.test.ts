import { IncomingMessage, ServerResponse, createServer, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { Duplex } from "node:stream";
import { NextRequestAdapter } from "next/dist/server/web/spec-extension/adapters/next-request";
import { NodeNextRequest } from "next/dist/server/base-http/node";
import { afterEach, expect, it, vi } from "vitest";
import { installIngress } from "./ingress.mjs";
import { publishedJsonBody } from "@/lib/publish/published-body";

const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

/** A listening server behind the ingress. A POST body reaches `read` through
 * the framework's own conversion of the native request; any refusal is written
 * as its status and code. Every other method answers 200. It records when the
 * server's own side of its first connection is gone. */
async function serve(read: (request: Request) => Promise<unknown>): Promise<{ port: number; closedAt: () => number | undefined }> {
  installIngress();
  const server = createServer(async (incoming, response) => {
    if (incoming.method !== "POST") { response.end("next"); return; }
    try {
      await read(NextRequestAdapter.fromNodeNextRequest(new NodeNextRequest(incoming), new AbortController().signal));
      response.end("read");
    } catch (error) {
      const { status = 500, code = "internal" } = error as { status?: number; code?: string };
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ code }));
    }
  });
  let closedAt: number | undefined;
  server.once("connection", (socket: Socket) => { socket.once("close", () => { closedAt = performance.now(); }); });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, closedAt: () => closedAt };
}

/** The published bound for closing a refused connection whose body is unread. */
const DELIVERY_BOUND_MS = 5_000;
/** More than loopback buffers hold: the server stops reading long before the
 * body ends, so its end can never close the connection by itself. */
const UNREAD_PIECES = 160;

/** A keep-alive client that does not stop at a refusal: it sends the whole
 * chunked body, then a second request on the same connection. It never closes
 * its own side, so only the server can end the connection. */
async function sendAllThenAsk({ port, closedAt }: Awaited<ReturnType<typeof serve>>, target: string, contentType: string, pieces: Buffer[]) {
  const socket = connect({ port, host: "127.0.0.1", allowHalfOpen: true });
  let text = "", answeredAt: number | undefined;
  socket.on("data", chunk => { text += chunk.toString("latin1"); answeredAt ??= performance.now(); });
  socket.on("error", () => {});
  socket.write(`POST ${target} HTTP/1.1\r\nHost: instance.test\r\nContent-Type: ${contentType}\r\nTransfer-Encoding: chunked\r\n\r\n`);
  for (const piece of pieces) socket.write(Buffer.concat([Buffer.from(piece.length.toString(16) + "\r\n"), piece, Buffer.from("\r\n")]));
  socket.write("0\r\n\r\nGET /next HTTP/1.1\r\nHost: instance.test\r\n\r\n");
  const statuses = () => [...text.matchAll(/HTTP\/1\.1 (\d{3})/g)].map(match => Number(match[1]));
  const deadline = performance.now() + DELIVERY_BOUND_MS + 3_000;
  while (closedAt() === undefined && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  const closed = closedAt();
  socket.destroy();
  return { statuses: statuses(), text, closedAfterMs: closed !== undefined && answeredAt !== undefined ? closed - answeredAt : undefined };
}

it.each(["widget-values", "render/layer", "extent/layer"])("answers the %s refusal, closes the unread connection within the delivery bound", async suffix => {
  const server = await serve(publishedJsonBody);
  const { statuses, text, closedAfterMs } = await sendAllThenAsk(server, `/api/published/token/${suffix}`, "application/json", Array<Buffer>(UNREAD_PIECES).fill(Buffer.alloc(65_536, " ")));
  expect(text).toContain('{"code":"request_body_too_large"}');
  expect(statuses).toEqual([413]);
  expect(text.toLowerCase()).toContain("connection: close");
  expect(closedAfterMs).toBeDefined(); expect(closedAfterMs!).toBeLessThan(DELIVERY_BOUND_MS + 1_000);
}, 15_000);

it("answers the multipart file-limit refusal, closes the unread connection within the delivery bound", async () => {
  const { receiveUpload } = await import("@/lib/ingest/receive");
  const { limits } = await import("@/lib/limits");
  vi.spyOn(limits, "uploadMaxBytes", "get").mockReturnValue(65_536);
  const data = await mkdtemp(path.join(process.env.DEZFIL_DATA_DIR!, "streaming-ingress-"));
  vi.stubEnv("DEZFIL_DATA_DIR", data);
  try {
    const server = await serve(receiveUpload);
    const { statuses, text, closedAfterMs } = await sendAllThenAsk(server, "/api/tables", "multipart/form-data; boundary=fixture", [
      Buffer.from('--fixture\r\nContent-Disposition: form-data; name="file"; filename="test.csv"\r\n\r\n'),
      ...Array<Buffer>(UNREAD_PIECES).fill(Buffer.alloc(65_536, "x")),
      Buffer.from("\r\n--fixture--\r\n"),
    ]);
    expect(text).toContain('{"code":"upload_too_large"}');
    expect(statuses).toEqual([413]);
    expect(text.toLowerCase()).toContain("connection: close");
    expect(closedAfterMs).toBeDefined(); expect(closedAfterMs!).toBeLessThan(DELIVERY_BOUND_MS + 1_000);
    expect(await readdir(path.join(data, "tmp"))).toEqual([]);
  } finally { vi.unstubAllEnvs(); await rm(data, { recursive: true, force: true }); }
}, 15_000);

it.each(["/api/tables", "/api/published/token/widget-values", "/api/published/token/render/layer", "/api/published/token/extent/layer", "/api/maps"])("answers TRACE on %s with an empty 400 before any handler or body read", async target => {
  installIngress();
  let reached = false;
  const server = createServer((_incoming, response) => { reached = true; response.end("handled"); });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const socket = connect((server.address() as AddressInfo).port, "127.0.0.1");
  let text = "";
  socket.on("data", chunk => { text += chunk.toString("latin1"); });
  socket.on("error", () => {});
  // A declared body that is never sent: an answer proves nothing waited for it.
  socket.write(`TRACE ${target} HTTP/1.1\r\nHost: instance.test\r\nContent-Length: 4194304\r\n\r\n`);
  const deadline = Date.now() + 2_000;
  while (!text.includes("\r\n\r\n") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  socket.destroy();
  expect(text).toMatch(/^HTTP\/1\.1 400 /);
  expect(text.toLowerCase()).toContain("content-length: 0");
  expect(text.toLowerCase()).toContain("cache-control: private, no-store");
  expect(text.split("\r\n\r\n")[1]).toBe("");
  expect(reached).toBe(false);
});

it.each([
  ["/api/tables/extra", "POST"], ["/api/recipes", "POST"], ["/api/auth/sign-in", "POST"],
  ["/api/published/token/render/layer/extra", "POST"], ["/api/published/token/%72ender/layer", "POST"],
  ["/api/published/token/widget-values", "PUT"],
])("owns cancellable reception for every ordinary request class: %s %s", (pathname, method) => {
  installIngress();
  const socket = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
  Object.defineProperty(socket, "remoteAddress", { value: "127.0.0.1" });
  const incoming = new IncomingMessage(socket as Socket);
  incoming.url = pathname; incoming.method = method;
  incoming.headers = { host: "instance.test" }; incoming.rawHeaders = ["host", "instance.test"];
  const iterator = incoming[Symbol.asyncIterator];
  const outgoing = new ServerResponse(incoming);
  try {
    createServer(() => {}).emit("request", incoming, outgoing);
    expect(incoming[Symbol.asyncIterator]).not.toBe(iterator);
  } finally { outgoing.emit("finish"); incoming.destroy(); socket.destroy(); }
});
