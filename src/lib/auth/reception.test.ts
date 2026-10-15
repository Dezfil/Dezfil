import { createServer, request as httpRequest, Agent, type Server, type ClientRequest } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { NextRequestAdapter } from "next/dist/server/web/spec-extension/adapters/next-request";
import { NodeNextRequest } from "next/dist/server/base-http/node";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nativeUploadReception } from "./reception.mjs";
import { installIngress } from "./ingress.mjs";
import { receiveUpload } from "@/lib/ingest/receive";
import { removeAccountFile } from "@/lib/ingest/file-ownership";
import * as fileOwnership from "@/lib/ingest/file-ownership";
import { limits } from "@/lib/limits";
import { errorResponse } from "@/lib/api/errors";

const root = process.env.DEZFIL_DATA_DIR!;
const realTimeout = setTimeout, realClearTimeout = clearTimeout;
const pause = (ms = 5) => new Promise<void>(resolve => realTimeout(resolve, ms));
let directory: string;
const servers: Server[] = [], clients: ClientRequest[] = [], pending: Promise<unknown>[] = [];
beforeEach(async () => {
  directory = await mkdtemp(path.join(root, "reception-")); vi.stubEnv("DEZFIL_DATA_DIR", directory);
  vi.spyOn(limits, "uploadMaxBytes", "get").mockReturnValue(65536);
  vi.spyOn(limits, "dataProcessingTimeoutMs", "get").mockReturnValue(180000);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});
afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await Promise.allSettled(pending.splice(0));
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true });
});
async function serve(signal = new AbortController().signal) {
  installIngress();
  const admitted = Promise.withResolvers<void>();
  const server = createServer((incoming, outgoing) => {
    const run = async () => {
      if (incoming.method === "GET") { outgoing.end("healthy"); return; }
      const req = NextRequestAdapter.fromNodeNextRequest(new NodeNextRequest(incoming), signal);
      try {
        const work = incoming.url === "/api/tables" ? receiveUpload(req) : req.text();
        admitted.resolve();
        const result = await work;
        if (typeof result !== "string") await removeAccountFile(result.tmpPath);
        if (!outgoing.destroyed && !outgoing.writableEnded) outgoing.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ accepted: true }));
      } catch (error) {
        if (outgoing.destroyed || outgoing.writableEnded) return;
        const answer = errorResponse(error);
        outgoing.writeHead(answer.status, { "content-type": "application/json" }).end(await answer.text());
      }
    };
    pending.push(run());
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, admitted: admitted.promise, port: (server.address() as AddressInfo).port };
}
function send(port: number, target = "/api/tables", method = "POST", agent?: Agent) {
  let received = false;
  const response = Promise.withResolvers<{ status: number; body: { error?: { code: string; message: string } }; text: string }>();
  const req = httpRequest({ host: "127.0.0.1", port, path: target, method, agent,
    headers: method === "GET" ? {} : { "content-type": "multipart/form-data; boundary=reception", "transfer-encoding": "chunked" } }, res => {
    let text = ""; res.setEncoding("utf8"); res.on("data", chunk => { text += chunk; });
    res.on("error", response.reject); res.on("end", () => {
      received = true;
      response.resolve({ status: res.statusCode!, text, body: text.startsWith("{") ? JSON.parse(text) : {} });
    });
  });
  clients.push(req); req.on("error", response.reject); req.flushHeaders();
  const guard = realTimeout(() => { response.reject(new Error("No response while the sender is silent.")); req.destroy(); }, 2000);
  const result = response.promise.finally(() => realClearTimeout(guard));
  void result.catch(() => {});
  return { req, result, received: () => received };
}
const prefix = '--reception\r\nContent-Disposition: form-data; name="file"; filename="points.csv"\r\n\r\n';
const ending = "\r\n--reception--\r\n";
async function bytesOnDisk(minimum = 1) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const files = await readdir(path.join(directory, "tmp")).catch(() => []);
    const sizes = await Promise.all(files.map(file => stat(path.join(directory, "tmp", file)).then(s => s.size).catch(() => 0)));
    if (sizes.some(size => size >= minimum)) return;
    await pause();
  }
  throw new Error("No partial upload reached disk.");
}
async function noPartial() { expect(await readdir(path.join(directory, "tmp")).catch(() => [])).toEqual([]); }

it("puts the native server clock above every stored application receive deadline without changing the header bound", async () => {
  const { server, port } = await serve(); const client = send(port, "/health", "GET"); client.req.end();
  expect((await client.result).status).toBe(200);
  expect(server.requestTimeout).toBeGreaterThan(21600000); expect(server.headersTimeout).toBe(60000);
});

it.each([false, true])("answers silence with upload_stalled, including before the first byte (mid-body=%s)", async midBody => {
  const { port, admitted } = await serve(); const client = send(port); await admitted;
  if (midBody) { client.req.write(prefix + "lon,lat\n1,2\n"); await bytesOnDisk(); }
  await vi.advanceTimersByTimeAsync(59999); expect(client.received()).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await client.result).toMatchObject({ status: 408, body: { error: { code: "upload_stalled", message: expect.stringContaining("60 s") } } });
  await noPartial();
});

it("returns the first size refusal to a silent sender and recovers on the next request", async () => {
  const { port, admitted } = await serve(); const client = send(port); await admitted;
  client.req.write(prefix + "x".repeat(65535)); await bytesOnDisk(65535);
  client.req.write("x");
  expect(await client.result).toMatchObject({ status: 413, body: { error: { code: "upload_too_large" } } });
  await vi.advanceTimersByTimeAsync(60000); await noPartial();
  const next = send(port); next.req.end(prefix + "lon,lat\n1,2\n" + ending);
  expect((await next.result).status).toBe(201); await noPartial();
});

it("bounds continuous progress by the admitted reception deadline", async () => {
  vi.spyOn(limits, "dataProcessingTimeoutMs", "get").mockReturnValue(120000);
  const { port, admitted } = await serve(); const client = send(port); await admitted;
  client.req.write(prefix + "lon,lat\n"); await bytesOnDisk(8);
  for (let index = 1; index <= 2; index++) {
    await vi.advanceTimersByTimeAsync(40000); client.req.write("1,2\n"); await bytesOnDisk(8 + index * 4);
  }
  await vi.advanceTimersByTimeAsync(40000);
  expect(await client.result).toMatchObject({ status: 408, body: { error: { code: "data_processing_timeout", message: expect.stringContaining("120 s reception") } } });
  await noPartial();
});

it.each(["/api/query", "/api/auth/sign-in", "/api/maps/map/thumbnail", "/api/published/token/widget-values"])("retains the ordinary receive deadline on %s", async target => {
  const { port, admitted } = await serve(); const client = send(port, target); await admitted;
  await vi.advanceTimersByTimeAsync(299999); expect(client.received()).toBe(false);
  await vi.advanceTimersByTimeAsync(1001);
  expect(await client.result).toMatchObject({ status: 408, body: { error: { code: "request_timeout" } } });
});

it("reuses a completely received connection and keeps simultaneous ordinary requests independent", async () => {
  const { port, admitted } = await serve(); const agent = new Agent({ keepAlive: true });
  try {
    const upload = send(port); await admitted; upload.req.write(prefix + "lon,lat\n"); await bytesOnDisk();
    const first = send(port, "/health", "GET", agent); first.req.end(); expect((await first.result).status).toBe(200);
    const socket = first.req.socket;
    const second = send(port, "/health", "GET", agent); second.req.end(); expect((await second.result).status).toBe(200);
    expect(second.req.socket).toBe(socket);
    upload.req.end("1,2\n" + ending); expect((await upload.result).status).toBe(201);
  } finally { agent.destroy(); }
});

it.each([
  ["accepted", prefix + "lon,lat\n1,2\n" + ending, 201],
  ["refused for the wrong field", '--reception\r\nContent-Disposition: form-data; name="other"; filename="points.csv"\r\n\r\nlon,lat\n1,2\n\r\n--reception--\r\n', 400],
  ["refused as too large", prefix + "x".repeat(70000) + ending, 413],
  ["refused as not multipart", "{}", 400],
] as const)("keeps a completely received connection reusable after an upload %s", async (_outcome, body, status) => {
  const { port } = await serve(); const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const first = send(port, "/api/tables", "POST", agent); first.req.end(body);
    expect((await first.result).status).toBe(status);
    await pause(20);
    const second = send(port, "/api/tables", "POST", agent); second.req.write(prefix + "lon,lat\n"); await bytesOnDisk(8);
    expect(second.req.socket).toBe(first.req.socket);
    // The next upload on that connection outlives the refusal delivery bound.
    await vi.advanceTimersByTimeAsync(5000); await pause(20);
    second.req.end("1,2\n" + ending); expect((await second.result).status).toBe(201);
  } finally { agent.destroy(); }
});

it("raises the server clock for a deployment override above the stored range", async () => {
  vi.spyOn(limits, "dataProcessingTimeoutMs", "get").mockReturnValue(30_000_000);
  const { server, port, admitted } = await serve(); const client = send(port); await admitted;
  expect(server.requestTimeout).toBeGreaterThan(30_000_000);
  client.req.end(prefix + "lon,lat\n1,2\n" + ending); expect((await client.result).status).toBe(201);
});

it("keeps the admitted reception deadline when settings change during receipt", async () => {
  vi.spyOn(limits, "dataProcessingTimeoutMs", "get").mockReturnValue(120000);
  const { port, admitted } = await serve(); const client = send(port); await admitted;
  client.req.write(prefix + "lon,lat\n"); await bytesOnDisk(8);
  vi.spyOn(limits, "dataProcessingTimeoutMs", "get").mockReturnValue(60000);
  await vi.advanceTimersByTimeAsync(40000); client.req.write("1,2\n"); await bytesOnDisk(12);
  await vi.advanceTimersByTimeAsync(40000);
  client.req.end("3,4\n" + ending); expect((await client.result).status).toBe(201); await noPartial();
});

it("cleans incomplete reception when the native sender leaves", async () => {
  const { port, admitted } = await serve(); const client = send(port); await admitted;
  client.req.write(prefix + "lon,lat\n1,2\n"); await bytesOnDisk(); client.req.destroy();
  await Promise.allSettled(pending); await noPartial();
  const next = send(port); next.req.end(prefix + "lon,lat\n1,2\n" + ending);
  expect((await next.result).status).toBe(201);
});

it("delivers the first refusal within one second even while application cleanup is pending", async () => {
  installIngress(); const admitted = Promise.withResolvers<void>();
  let socket!: import("node:net").Socket, answer!: import("node:http").ServerResponse;
  const server = createServer((incoming, outgoing) => {
    socket = incoming.socket; answer = outgoing;
    const owner = nativeUploadReception(180000, "Settings > Limits", () => {});
    owner!.refuse(Object.assign(new Error("The size cap was reached."), { status: 413, code: "upload_too_large" }));
    admitted.resolve();
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const client = send((server.address() as AddressInfo).port); await admitted.promise;
  await vi.advanceTimersByTimeAsync(1000);
  expect(await client.result).toMatchObject({ status: 413, body: { error: { code: "upload_too_large", message: "The size cap was reached." } } });
  // The delayed handler cannot replace or append to the decided answer.
  expect(() => answer.writeHead(500).end("late failure")).not.toThrow();
  socket.destroy();
});

it("closes a refused connection within the delivery bound when the peer keeps its side open", async () => {
  installIngress(); const decided = Promise.withResolvers<void>();
  let socket!: import("node:net").Socket;
  const server = createServer(incoming => {
    socket = incoming.socket;
    nativeUploadReception(180000, "Settings > Limits", () => {})!
      .refuse(Object.assign(new Error("The size cap was reached."), { status: 413, code: "upload_too_large" }));
    decided.resolve();
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  // This peer neither finishes its body nor closes its side when the answer ends.
  const peer = connect({ port: (server.address() as AddressInfo).port, host: "127.0.0.1", allowHalfOpen: true });
  let text = "", ended = false, closed = false, serverClosed = false;
  peer.on("data", chunk => { text += chunk.toString("latin1"); });
  peer.on("end", () => { ended = true; }); peer.on("close", () => { closed = true; }); peer.on("error", () => {});
  peer.write("POST /api/tables HTTP/1.1\r\nHost: instance.test\r\nContent-Type: multipart/form-data; boundary=reception\r\nTransfer-Encoding: chunked\r\n\r\n");
  try {
    await decided.promise; socket.once("close", () => { serverClosed = true; });
    await vi.advanceTimersByTimeAsync(1000);
    for (let attempt = 0; attempt < 200 && !ended; attempt++) await pause();
    expect(text).toMatch(/^HTTP\/1\.1 413 /); expect(text.toLowerCase()).toContain("connection: close");
    // The answer ended the server's side, and the peer's side stays open.
    await vi.advanceTimersByTimeAsync(3999); await pause(20);
    expect(ended).toBe(true); expect(socket.destroyed).toBe(false); expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    for (let attempt = 0; attempt < 200 && !serverClosed; attempt++) await pause();
    expect(socket.destroyed).toBe(true); expect(serverClosed).toBe(true);
  } finally { peer.destroy(); }
});

it("keeps application cancellation bodyless while file cleanup is delayed", async () => {
  const caller = new AbortController(), cleaning = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const remove = fileOwnership.removeAccountFile;
  vi.spyOn(fileOwnership, "removeAccountFile").mockImplementation(async (...args) => { cleaning.resolve(); await release.promise; return remove(...args); });
  const { port, admitted } = await serve(caller.signal); const client = send(port); await admitted;
  client.req.write(prefix + "lon,lat\n1,2\n"); await bytesOnDisk(); caller.abort(); await cleaning.promise;
  try {
    await vi.advanceTimersByTimeAsync(1000); expect(client.received()).toBe(false);
  } finally { release.resolve(); }
  expect(await client.result).toMatchObject({ status: 499, text: "" }); await noPartial();
});
