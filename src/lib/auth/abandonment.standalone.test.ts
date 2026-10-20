import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, type Socket } from "node:net";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { authenticatedRequest } from "@/lib/assistant/testing/account";
import { closeMetadataDb } from "@/lib/metadata/db";

/** Run against a production standalone started with the ingress preload and
 * scripts/abandonment-control.mjs, sharing the same fresh DEZFIL_DATA_DIR,
 * with its output in the file DEZFIL_ABANDONMENT_LOG names. Provisioning is in
 * abandonment.standalone.md beside this file. No listener or build is started by this suite. */
const port = process.env.DEZFIL_ABANDONMENT_PORT;
const output = process.env.DEZFIL_ABANDONMENT_LOG;
const UNHANDLED = /uncaughtException:|unhandledRejection:/g;
const UNRELATED = "Unrelated failure after the caller left.";

describe.skipIf(!port)("production abandonment", () => {
  let authorization: string, held = 0;
  const host = `127.0.0.1:${port}`, base = `http://${host}`;
  const sockets = new Set<Socket>();
  const serverLog = () => readFile(output!, "utf8");
  /** What the server wrote while `work` ran and its departures settled. */
  async function logged(work: () => Promise<void>) {
    const before = (await serverLog()).length;
    await work(); await delay(1000);
    return (await serverLog()).slice(before);
  }
  async function answered() {
    const started = performance.now();
    const health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5000) });
    expect(health.status).toBe(200); await health.arrayBuffer();
    const maps = await fetch(`${base}/api/maps`, { headers: { authorization }, signal: AbortSignal.timeout(5000) });
    expect(maps.status).toBe(200); await maps.arrayBuffer();
    expect(performance.now() - started).toBeLessThan(5000);
  }
  async function open() {
    const socket = connect(Number(port), "127.0.0.1"); sockets.add(socket); socket.on("error", () => {});
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    return socket;
  }
  const refusal = (method: string, target: string, mark = "") =>
    `${method} ${target} HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${base}\r\nContent-Type: application/json\r\nContent-Length: 2\r\n${mark}\r\n{}`;
  /** One connection that never reads: answers far larger than the socket can
   * buffer, then a request the proxy refuses itself. Its refusal waits behind
   * them, so the caller leaves before it finishes. */
  async function leaveRefusal(request: string) {
    const socket = await open();
    // One write, so the server reads every request before the answers block it.
    socket.write(`GET /api/openapi.json HTTP/1.1\r\nHost: ${host}\r\nAuthorization: ${authorization}\r\n\r\n`.repeat(held) + request);
    await delay(2000); socket.destroy();
  }

  beforeAll(async () => {
    if (!/^\/tmp\/dezfil-test-/.test(process.env.DEZFIL_DATA_DIR ?? "")) throw new Error("Use a fresh /tmp/dezfil-test-* directory shared with the standalone.");
    if (!/^\d+$/.test(port ?? "")) throw new Error("DEZFIL_ABANDONMENT_PORT must name the running standalone's port.");
    if (!output) throw new Error("DEZFIL_ABANDONMENT_LOG must name the file the standalone writes its output to.");
    closeMetadataDb(); authorization = authenticatedRequest().headers.get("authorization")!;
    const document = await fetch(`${base}/api/openapi.json`, { headers: { authorization }, signal: AbortSignal.timeout(10000) });
    expect(document.status).toBe(200);
    held = Math.ceil(16 * 1024 * 1024 / (await document.arrayBuffer()).byteLength);
    await answered();
  });
  afterAll(() => {
    for (const socket of sockets) socket.destroy();
    closeMetadataDb();
  });

  it.each([["POST", "/api/maps"], ["PATCH", "/api/maps/fixture"], ["DELETE", "/api/maps/fixture"]])(
    "a caller who leaves before the proxy's own %s %s refusal finishes raises no unhandled event, and the next request is answered",
    async (method, target) => {
      const added = await logged(() => leaveRefusal(refusal(method, target)));
      expect(added.match(UNHANDLED) ?? [], added).toEqual([]);
      await answered();
    }, 30000);

  it("a caller who leaves in the middle of a body raises no unhandled event, and the next request is answered", async () => {
    const added = await logged(async () => {
      const socket = await open();
      socket.write(`POST /api/maps HTTP/1.1\r\nHost: ${host}\r\nAuthorization: ${authorization}\r\nOrigin: ${base}\r\nContent-Type: application/json\r\nContent-Length: 64\r\n\r\n{"name":`);
      await delay(1000); socket.destroy();
    });
    expect(added.match(UNHANDLED) ?? [], added).toEqual([]);
    await answered();
  }, 30000);

  it("keeps an unrelated failure on a departed request visible in the log", async () => {
    const added = await logged(() => leaveRefusal(refusal("POST", "/api/maps", "X-Dezfil-Test-Unrelated-Failure: 1\r\n")));
    expect(added.match(UNHANDLED) ?? [], added).toEqual(["uncaughtException:"]);
    expect(added).toContain(UNRELATED);
    expect(added).not.toContain("Error: aborted");
    await answered();
  }, 30000);
});
