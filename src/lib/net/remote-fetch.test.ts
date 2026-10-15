import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { text } from "node:stream/consumers";
import { openRemote } from "./remote-fetch";
import { keepRequestsOnThisMachine } from "@/lib/test-support/outside-requests";

// Every exchange here is with a loopback fixture; one that went anywhere
// else fails its test before it leaves this machine.
keepRequestsOnThisMachine();

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let servers: Server[] = [];

async function serve(handler: Handler): Promise<{
  port: number;
  connections: () => number;
}> {
  const server = createServer(handler);
  let count = 0;
  server.on("connection", () => count++);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  servers.push(server);
  return {
    port: (server.address() as AddressInfo).port,
    connections: () => count,
  };
}

beforeEach(() => {
  servers = [];
});

afterEach(async () => {
  delete process.env.DEZFIL_EGRESS_ALLOWLIST;
  await Promise.all(
    servers.map(
      (s) => new Promise<void>((resolve) => s.close(() => resolve())),
    ),
  );
});

describe("openRemote — egress policy", () => {
  it("blocks a loopback IP literal by default, without connecting", async () => {
    const { port, connections } = await serve((_req, res) => res.end("x"));
    await expect(
      openRemote(`http://127.0.0.1:${port}/file.csv`),
    ).rejects.toMatchObject({ code: "egress_blocked", status: 403 });
    expect(connections()).toBe(0);
  });

  it("blocks a hostname resolving to loopback by default, without connecting", async () => {
    const { port, connections } = await serve((_req, res) => res.end("x"));
    await expect(
      openRemote(`http://localhost:${port}/file.csv`),
    ).rejects.toMatchObject({ code: "egress_blocked", status: 403 });
    expect(connections()).toBe(0);
  });

  it("admits an allowlisted destination and returns the body", async () => {
    process.env.DEZFIL_EGRESS_ALLOWLIST = "127.0.0.1";
    const { port } = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello");
    });
    const response = await openRemote(`http://127.0.0.1:${port}/file.csv`);
    expect(response.statusCode).toBe(200);
    await expect(text(response.body)).resolves.toBe("hello");
  });

  it("re-checks the policy on every redirect hop", async () => {
    // First hop allowlisted by name; the redirect target is an IP literal
    // that is not allowlisted — it must be rejected before any connection.
    const target = await serve((_req, res) => res.end("secret"));
    const { port } = await serve((_req, res) => {
      res.writeHead(302, {
        location: `http://127.0.0.1:${target.port}/secret`,
      });
      res.end();
    });
    process.env.DEZFIL_EGRESS_ALLOWLIST = "localhost";
    await expect(
      openRemote(`http://localhost:${port}/start`),
    ).rejects.toMatchObject({ code: "egress_blocked" });
    expect(target.connections()).toBe(0);
  });

  it("rejects identically whether or not the blocked target is listening", async () => {
    const live = await serve((_req, res) => res.end("x"));
    const redirectTo = (dest: string) =>
      serve((_req, res) => {
        res.writeHead(302, { location: dest });
        res.end();
      });
    process.env.DEZFIL_EGRESS_ALLOWLIST = "localhost";

    const hopToLive = await redirectTo(`http://127.0.0.1:${live.port}/x`);
    const errLive = await openRemote(
      `http://localhost:${hopToLive.port}/`,
    ).catch((e) => e);
    const hopToDead = await redirectTo("http://10.255.255.1:9/x");
    const errDead = await openRemote(
      `http://localhost:${hopToDead.port}/`,
    ).catch((e) => e);

    expect({
      code: errLive.code,
      status: errLive.status,
      message: errLive.message,
    }).toEqual({
      code: errDead.code,
      status: errDead.status,
      message: errDead.message,
    });
    expect(live.connections()).toBe(0);
  });
});

describe("openRemote — redirects and bounds", () => {
  it("follows a relative redirect on the same allowlisted host", async () => {
    process.env.DEZFIL_EGRESS_ALLOWLIST = "127.0.0.1";
    const { port } = await serve((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { location: "/moved" });
        res.end();
      } else {
        res.end(`at ${req.url}`);
      }
    });
    const response = await openRemote(`http://127.0.0.1:${port}/start`);
    await expect(text(response.body)).resolves.toBe("at /moved");
    expect(response.finalUrl).toBe(`http://127.0.0.1:${port}/moved`);
  });

  it("gives up after too many redirects", async () => {
    process.env.DEZFIL_EGRESS_ALLOWLIST = "127.0.0.1";
    const { port } = await serve((_req, res) => {
      res.writeHead(302, { location: "/again" });
      res.end();
    });
    await expect(
      openRemote(`http://127.0.0.1:${port}/start`),
    ).rejects.toMatchObject({ code: "remote_fetch_failed" });
  });

  it("fails a hung exchange when a deadline is set", async () => {
    process.env.DEZFIL_EGRESS_ALLOWLIST = "127.0.0.1";
    const { port } = await serve(() => {
      /* Accept and never respond */
    });
    await expect(
      openRemote(`http://127.0.0.1:${port}/slow`, { timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: "remote_fetch_failed" });
  });

  it("sends caller headers on every hop, keeping the accept default", async () => {
    process.env.DEZFIL_EGRESS_ALLOWLIST = "127.0.0.1";
    const seen: Record<string, string | undefined>[] = [];
    const { port } = await serve((req, res) => {
      seen.push({
        ua: req.headers["user-agent"],
        accept: req.headers.accept,
      });
      if (req.url === "/start") {
        res.writeHead(302, { location: "/moved" });
        res.end();
      } else {
        res.end("ok");
      }
    });
    const response = await openRemote(`http://127.0.0.1:${port}/start`, {
      headers: { "user-agent": "Dezfil-test" },
    });
    await text(response.body);
    expect(seen).toHaveLength(2);
    for (const hop of seen) {
      expect(hop.ua).toBe("Dezfil-test");
      expect(hop.accept).toBe("*/*");
    }
  });

  it("errors the body stream when the deadline fires mid-transfer", async () => {
    process.env.DEZFIL_EGRESS_ALLOWLIST = "127.0.0.1";
    const { port } = await serve((_req, res) => {
      res.writeHead(200, { "content-length": "10" });
      res.write("abc"); // then stall forever
    });
    const response = await openRemote(`http://127.0.0.1:${port}/stall`, {
      timeoutMs: 100,
    });
    await expect(text(response.body)).rejects.toMatchObject({
      code: "remote_fetch_failed",
    });
  });
});

describe("openRemote — a query sent with POST", () => {
  interface Seen { url: string; method: string; body: string; length?: string; type?: string; agent?: string }
  async function recording(answer: (req: IncomingMessage, res: ServerResponse) => void) {
    const seen: Seen[] = [];
    const fixture = await serve((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        seen.push({ url: req.url ?? "", method: req.method ?? "", body: Buffer.concat(chunks).toString("utf8"),
          length: req.headers["content-length"], type: req.headers["content-type"], agent: req.headers["user-agent"] });
        answer(req, res);
      });
    });
    return { seen, ...fixture };
  }
  const QUERY = "data=%5Bout%3Ajson%5D%3Bnode%3Bout%3B";
  const posting = { method: "POST" as const, body: QUERY, headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "Dezfil-test" } };

  it("sends the body with its length and the caller's headers", async () => {
    process.env.DEZFIL_EGRESS_ALLOWLIST = "127.0.0.1";
    const fixture = await recording((_req, res) => res.end("answered"));
    const response = await openRemote(`http://127.0.0.1:${fixture.port}/api/interpreter`, posting);
    await expect(text(response.body)).resolves.toBe("answered");
    expect(fixture.seen).toEqual([{ url: "/api/interpreter", method: "POST", body: QUERY, length: String(QUERY.length),
      type: "application/x-www-form-urlencoded", agent: "Dezfil-test" }]);
  });

  it.each([307, 308])("keeps the method and the body across a %i", async (status) => {
    process.env.DEZFIL_EGRESS_ALLOWLIST = "127.0.0.1";
    const fixture = await recording((req, res) => {
      if (req.url === "/start") { res.writeHead(status, { location: "/moved" }); res.end(); } else res.end("answered");
    });
    const response = await openRemote(`http://127.0.0.1:${fixture.port}/start`, posting);
    await expect(text(response.body)).resolves.toBe("answered");
    expect(fixture.seen.map(({ url, method, body }) => [url, method, body])).toEqual([["/start", "POST", QUERY], ["/moved", "POST", QUERY]]);
  });

  it.each([301, 302, 303])("asks the next hop with a GET and no body after a %i", async (status) => {
    process.env.DEZFIL_EGRESS_ALLOWLIST = "127.0.0.1";
    const fixture = await recording((req, res) => {
      if (req.url === "/start") { res.writeHead(status, { location: "/moved" }); res.end(); } else res.end("answered");
    });
    const response = await openRemote(`http://127.0.0.1:${fixture.port}/start`, posting);
    await expect(text(response.body)).resolves.toBe("answered");
    expect(fixture.seen.map(({ url, method, body, length, type }) => [url, method, body, length, type])).toEqual([
      ["/start", "POST", QUERY, String(QUERY.length), "application/x-www-form-urlencoded"],
      ["/moved", "GET", "", undefined, undefined],
    ]);
  });

  it("re-checks the policy on every hop, refusing a redirect into blocked space before contact", async () => {
    const target = await serve((_req, res) => res.end("secret"));
    const fixture = await recording((_req, res) => { res.writeHead(307, { location: `http://127.0.0.1:${target.port}/secret` }); res.end(); });
    process.env.DEZFIL_EGRESS_ALLOWLIST = "localhost";
    await expect(openRemote(`http://localhost:${fixture.port}/start`, posting)).rejects.toMatchObject({ code: "egress_blocked", status: 403 });
    expect(fixture.seen).toHaveLength(1);
    expect(target.connections()).toBe(0);
  });

  it("refuses blocked space on the first hop without sending the body", async () => {
    const fixture = await recording((_req, res) => res.end("answered"));
    await expect(openRemote(`http://127.0.0.1:${fixture.port}/api/interpreter`, posting)).rejects.toMatchObject({ code: "egress_blocked" });
    expect(fixture.connections()).toBe(0);
  });
});

describe("openRemote — abandonment", () => {
  /**
   * **The deadline is not a substitute for a cancel.**
   *
   * Before this, a caller who stopped wanting an answer had no way to say so:
   * the socket stayed open until the whole timeout elapsed, with the provider's
   * quota already spent and nothing left that wanted the result. That is what
   * records, and what a batch geocode cancelled halfway would otherwise do for
   * every address still in flight.
   *
   * So these assert the **connection closing**, observed at the server, rather
   * than the promise rejecting — which a timeout would also produce, and which
   * is exactly the measurement that would let a broken abort pass.
   */
  it("rejects an exchange still waiting for a response, well before the deadline", async () => {
    // The case a cancelled batch actually hits: the request is out, the
    // provider has not answered, and nobody wants the answer any more.
    let closedEarly = false;
    let opened = false;
    const { port } = await serve((req, res) => {
      opened = true;
      // Headers are never sent, so only an abort can end this.
      res.on("close", () => {
        closedEarly = true;
      });
      req.socket.on("close", () => {
        closedEarly = true;
      });
    });
    process.env.DEZFIL_EGRESS_ALLOWLIST = "127.0.0.1";

    const controller = new AbortController();
    const started = Date.now();
    const pending = openRemote(`http://127.0.0.1:${port}/slow`, {
      // Long enough that reaching it would prove the abort did nothing.
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(opened).toBe(true);
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      code: "remote_fetch_abandoned",
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    // The socket's own close lands a tick or two after the rejection.
    for (let i = 0; i < 50 && !closedEarly; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(closedEarly).toBe(true);
  }, 60_000);

  it("destroys a body still being delivered", async () => {
    // Headers arrive, so the call has already resolved; the exchange is the
    // body, and abandoning it has to stop that too — otherwise a cancelled
    // caller keeps a socket open for the rest of the deadline.
    const { port } = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("partial");
      // Deliberately unfinished.
    });
    process.env.DEZFIL_EGRESS_ALLOWLIST = "127.0.0.1";

    const controller = new AbortController();
    const response = await openRemote(`http://127.0.0.1:${port}/stream`, {
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    const reading = text(response.body);
    controller.abort();
    await expect(reading).rejects.toThrow();
  }, 60_000);

  it("never opens a socket for a signal that already fired", async () => {
    const { port, connections } = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    process.env.DEZFIL_EGRESS_ALLOWLIST = "127.0.0.1";
    await expect(
      openRemote(`http://127.0.0.1:${port}/x`, {
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ code: "remote_fetch_abandoned" });
    expect(connections()).toBe(0);
  }, 60_000);
});
