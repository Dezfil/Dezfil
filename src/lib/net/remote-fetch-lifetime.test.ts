import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { text } from "node:stream/consumers";
import { ApiError } from "@/lib/api/errors";
import { openRemote } from "./remote-fetch";

// A09's held 302, written afresh against this checkout. Teardown cannot
// supply evidence: every assertion about closure runs before closeAllConnections.
const servers: Server[] = [];
const sockets = new Set<Socket>();
let previousAllowlist: string | undefined;

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer((req, res) => {
    // A completed response may keep an idle pooled socket. It is no longer
    // unfinished exchange work and needs no forced destruction.
    res.on("finish", () => sockets.delete(req.socket));
    handler(req, res);
  });
  servers.push(server);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function heldRedirect(res: ServerResponse, location: string) {
  res.writeHead(302, { location });
  res.write("redirect bytes that never finish");
}

async function bounded<T>(pending: Promise<T>, ms = 2_000): Promise<T> {
  let timer: NodeJS.Timeout;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("exchange did not settle")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

async function closed() {
  // Only event-delivery grace, less than the assessment's 350 ms leak window.
  await expect.poll(() => sockets.size, { timeout: 100, interval: 5 }).toBe(0);
}

async function recovered(base: string) {
  const response = await openRemote(`${base}/ok`, { timeoutMs: 1_000 });
  expect(response.statusCode).toBe(200);
  expect(await text(response.body)).toBe("ok");
}

beforeEach(() => {
  sockets.clear();
  previousAllowlist = process.env.DEZFIL_EGRESS_ALLOWLIST;
  process.env.DEZFIL_EGRESS_ALLOWLIST = "127.0.0.1";
});
afterEach(async () => {
  if (previousAllowlist === undefined) delete process.env.DEZFIL_EGRESS_ALLOWLIST;
  else process.env.DEZFIL_EGRESS_ALLOWLIST = previousAllowlist;
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

describe("owned remote streams", () => {
  it("closes held redirects when the final body completes within the 100 ms budget", async () => {
    const base = await serve((req, res) => {
      if (req.url === "/start") heldRedirect(res, "/next");
      else if (req.url === "/next") heldRedirect(res, "/ok");
      else res.end("ok");
    });
    const response = await openRemote(`${base}/start`, { timeoutMs: 100 });
    expect(await text(response.body)).toBe("ok");
    await closed();
    await recovered(base);
  });

  for (const position of ["before headers", "mid-body"] as const) {
    for (const stop of ["caller abort", "default deadline", "import deadline"] as const) {
      it(`closes every held hop on ${stop} ${position}`, async () => {
        let reached!: () => void;
        const targetReached = new Promise<void>((resolve) => { reached = resolve; });
        const base = await serve((req, res) => {
          if (req.url === "/start") heldRedirect(res, "/next");
          else if (req.url === "/next") heldRedirect(res, "/target");
          else if (req.url === "/ok") res.end("ok");
          else {
            if (position === "mid-body") {
              res.writeHead(200);
              res.write("partial final body");
            }
            reached();
          }
        });
        const controller = new AbortController();
        const outcome = openRemote(`${base}/start`, {
          signal: controller.signal,
          timeoutMs: stop === "caller abort" ? 30_000 : 250,
          ...(stop === "import deadline" ? {
            timeoutError: () => new ApiError("remote_timeout", "Remote import timed out.", 504),
          } : {}),
        }).then(async (response) => { await text(response.body); }).catch((error: unknown) => error);
        await bounded(targetReached);
        if (stop === "caller abort") controller.abort();
        expect(await bounded(outcome)).toMatchObject({
          code: stop === "caller abort" ? "remote_fetch_abandoned"
            : stop === "import deadline" ? "remote_timeout" : "remote_fetch_failed",
          status: stop === "caller abort" ? 499 : stop === "import deadline" ? 504 : 502,
        });
        await closed();
        await recovered(base);
      });
    }
  }

  it("opens no connection for an already aborted caller and then recovers", async () => {
    let requests = 0;
    const base = await serve((_req, res) => { requests++; res.end("ok"); });
    await expect(openRemote(`${base}/start`, { signal: AbortSignal.abort() }))
      .rejects.toMatchObject({ code: "remote_fetch_abandoned", status: 499 });
    expect(requests).toBe(0);
    expect(sockets.size).toBe(0);
    await recovered(base);
  });

  it.each([
    ["invalid Location", "http://[", "remote_fetch_failed", 502],
    ["unsupported scheme", "file:///tmp/secret", "remote_fetch_failed", 502],
    ["blocked target", "blocked", "egress_blocked", 403],
    ["sixth redirect", "/again", "remote_fetch_failed", 502],
  ])("codes and closes a held redirect refusal: %s", async (_label, location, code, status) => {
    let blockedContacts = 0;
    const blocked = await serve((_req, res) => { blockedContacts++; res.end("secret"); });
    let hops = 0;
    const base = await serve((req, res) => {
      if (req.url === "/ok") res.end("ok");
      else {
        hops++;
        // Only the first hostname is allowlisted; its redirect IP is blocked.
        heldRedirect(res, location === "blocked" ? blocked : location);
      }
    });
    if (location === "blocked") process.env.DEZFIL_EGRESS_ALLOWLIST = "localhost";
    const start = location === "blocked" ? base.replace("127.0.0.1", "localhost") : base;
    const error = await openRemote(`${start}/start`, { timeoutMs: 1_000 }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code, status });
    expect(blockedContacts).toBe(0);
    expect(hops).toBe(location === "/again" ? 6 : 1);
    await closed();
    process.env.DEZFIL_EGRESS_ALLOWLIST = "127.0.0.1";
    await recovered(base);
  });
});
