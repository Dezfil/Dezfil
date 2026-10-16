import { createServer, createConnection, type Server, type Socket } from "node:net";
import { expect } from "vitest";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
export async function until(check: () => boolean, ms = 1_500) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise(r => setTimeout(r, 5));
  expect(check(), "observation missing before its bound").toBe(true);
}
export function socksRequest(host: string, port: number, type: "domain" | "ipv4" | "ipv6" = "domain") {
  const address = type === "ipv4" ? [1, ...host.split(".").map(Number)] : type === "ipv6"
    ? [4, ...Buffer.alloc(15), 1] : [3, Buffer.byteLength(host), ...Buffer.from(host)];
  return Buffer.from([5, 1, 0, 5, 1, 0, ...address, port >> 8, port & 255]);
}
/** All fixture resources are named here. Assertions run before this teardown. */
export class RelaySockets {
  private servers: Server[] = [];
  private sockets = new Set<Socket>();
  private own(socket: Socket) {
    this.sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => this.sockets.delete(socket));
    return socket;
  }
  async target(host = "127.0.0.1", port = 0) {
    const active = new Set<Socket>();
    let contacts = 0, bytes = 0;
    const server = createServer(socket => {
      this.own(socket); active.add(socket); contacts++;
      socket.once("close", () => active.delete(socket));
      socket.on("data", chunk => { bytes += chunk.length; socket.write(chunk); });
    });
    this.servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject); server.listen(port, host, () => { server.off("error", reject); resolve(); });
    });
    return { port: (server.address() as { port: number }).port, host, active,
      get contacts() { return contacts; }, get bytes() { return bytes; },
      reset() { contacts = 0; bytes = 0; } };
  }
  async client(port: number, host = "127.0.0.1") {
    const socket = this.own(createConnection({ port, host }));
    let bytes = Buffer.alloc(0), closed = false;
    socket.on("data", (chunk: Buffer) => { bytes = Buffer.concat([bytes, chunk]); });
    socket.once("close", () => { closed = true; });
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    return { socket, get bytes() { return bytes; }, get closed() { return closed; },
      async read(n: number) { await until(() => bytes.length >= n || closed); expect(bytes.length).toBeGreaterThanOrEqual(n); return bytes.subarray(0, n); } };
  }
  async live(target: Awaited<ReturnType<RelaySockets["target"]>>) {
    const client = await this.client(target.port, target.host);
    client.socket.write("live"); expect((await client.read(4)).toString()).toBe("live");
    client.socket.destroy(); await until(() => target.active.size === 0); target.reset();
  }
  /** Refused now, or, given `withinMs`, by then: a listener that closes on
   * its own timer at the deadline the caller answered on may still be
   * open the instant the answer arrives. */
  async assertClosed(port: number, withinMs = 0) {
    const end = Date.now() + withinMs;
    let outcome = await this.probe(port);
    while (outcome !== "ECONNREFUSED" && Date.now() < end) {
      await new Promise(r => setTimeout(r, 5));
      outcome = await this.probe(port);
    }
    expect(outcome).toBe("ECONNREFUSED");
  }
  private async probe(port: number) {
    const socket = this.own(createConnection({ port, host: "127.0.0.1" }));
    return await new Promise<string>(resolve => {
      const timer = setTimeout(() => { socket.destroy(); resolve("timeout"); }, 500);
      socket.once("error", (error: NodeJS.ErrnoException) => { clearTimeout(timer); resolve(error.code ?? "unknown"); });
      socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve("connected"); });
    });
  }
  async close() {
    for (const socket of this.sockets) socket.destroy();
    await Promise.all(this.servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  }
}
