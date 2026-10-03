import { IncomingMessage, createServer } from "node:http";
import { Duplex } from "node:stream";
import type { Socket } from "node:net";
import { NextRequestAdapter } from "next/dist/server/web/spec-extension/adapters/next-request";
import { NodeNextRequest } from "next/dist/server/base-http/node";
import { expect, it, vi } from "vitest";
import { installIngress } from "./ingress.mjs";
import { publishedJsonBody } from "@/lib/publish/published-body";

it.each(["widget-values", "render/layer", "extent/layer"])("keeps the native response socket writable when the %s reader cancels", async suffix => {
  installIngress();
  const socket = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
  Object.defineProperty(socket, "remoteAddress", { value: "127.0.0.1" });
  const incoming = new IncomingMessage(socket as Socket);
  incoming.url = `/api/published/token/${suffix}`;
  incoming.method = "POST";
  incoming.headers = { host: "instance.test" };
  incoming.rawHeaders = ["host", "instance.test"];
  incoming.on("error", () => {});
  let pending: Promise<unknown> | undefined;
  const server = createServer(() => {
    const request = NextRequestAdapter.fromNodeNextRequest(new NodeNextRequest(incoming), new AbortController().signal);
    pending = publishedJsonBody(request);
  });
  server.emit("request", incoming);
  incoming.push(Buffer.alloc(65_537, " "));
  try {
    await expect(pending).rejects.toMatchObject({ status: 413, code: "request_body_too_large" });
    expect(incoming.destroyed).toBe(false);
    expect(socket.destroyed).toBe(false);
    expect(incoming.readableFlowing).not.toBe(true);
  } finally { incoming.destroy(); socket.destroy(); }
});

it.each([
  ["/api/tables/extra", "POST"], ["/api/recipes", "POST"], ["/api/auth/sign-in", "POST"],
  ["/api/published/token/render/layer/extra", "POST"], ["/api/published/token/%72ender/layer", "POST"],
  ["/api/published/token/widget-values", "PUT"],
])("keeps native iterator ownership outside streaming POST admission: %s %s", (pathname, method) => {
  installIngress();
  const socket = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
  Object.defineProperty(socket, "remoteAddress", { value: "127.0.0.1" });
  const incoming = new IncomingMessage(socket as Socket);
  incoming.url = pathname; incoming.method = method;
  incoming.headers = { host: "instance.test" }; incoming.rawHeaders = ["host", "instance.test"];
  const iterator = incoming[Symbol.asyncIterator];
  try {
    createServer(() => {}).emit("request", incoming);
    expect(incoming[Symbol.asyncIterator]).toBe(iterator);
  } finally { incoming.destroy(); socket.destroy(); }
});


it("keeps the native response socket writable after the multipart file limit", async () => {
  const { receiveUpload } = await import("@/lib/ingest/receive");
  const { limits } = await import("@/lib/limits");
  const cap = vi.spyOn(limits, "uploadMaxBytes", "get").mockReturnValue(65_536);
  installIngress();
  const socket = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
  Object.defineProperty(socket, "remoteAddress", { value: "127.0.0.1" });
  const incoming = new IncomingMessage(socket as Socket);
  incoming.url = "/api/tables"; incoming.method = "POST";
  incoming.headers = { host: "instance.test", "content-type": "multipart/form-data; boundary=fixture" };
  incoming.rawHeaders = Object.entries(incoming.headers).flat() as string[];
  incoming.on("error", () => {});
  let pending: Promise<unknown> | undefined;
  createServer(() => {
    pending = receiveUpload(NextRequestAdapter.fromNodeNextRequest(new NodeNextRequest(incoming), new AbortController().signal));
  }).emit("request", incoming);
  incoming.push(Buffer.concat([Buffer.from('--fixture\r\nContent-Disposition: form-data; name="file"; filename="test.csv"\r\n\r\n'), Buffer.alloc(65_537)]));
  try {
    await expect(pending).rejects.toMatchObject({ status: 413, code: "upload_too_large" });
    expect(incoming.destroyed).toBe(false);
    expect(socket.destroyed).toBe(false);
  } finally { cap.mockRestore(); incoming.destroy(); socket.destroy(); }
});
