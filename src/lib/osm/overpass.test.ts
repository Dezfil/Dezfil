import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  cacheKey,
  fetchOverpass,
  maintainOverpassCache,
  overpassEndpoint,
} from "./overpass";
import { keepRequestsOnThisMachine } from "@/lib/test-support/outside-requests";
import { egressBlockedError } from "@/lib/net/egress";
import { settingRemedy } from "@/lib/settings/remedy";

// Every request here goes to a loopback fixture; one that went to the public
// Overpass server instead fails its test before it leaves this machine.
keepRequestsOnThisMachine();

let dir: string;
let cache: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  // The fixtures live on loopback, which the egress check refuses unless
  // the allowlist names it, as an administrator's would.
  process.env.DEZFIL_EGRESS_ALLOWLIST = "127.0.0.1";
  cache = path.join(dir, "data", "cache", "overpass");
  await mkdir(cache, { recursive: true });
});

afterEach(async () => {
  delete process.env.DEZFIL_DATA_DIR;
  delete process.env.DEZFIL_EGRESS_ALLOWLIST;
  delete process.env.DEZFIL_OVERPASS_URL;
  delete process.env.DEZFIL_OVERPASS_CACHE_MB;
  delete process.env.DEZFIL_OVERPASS_CACHE_H;
  delete process.env.DEZFIL_OVERPASS_MAXSIZE_MB;
  await rm(dir, { recursive: true, force: true });
});

async function seedEntry(
  name: string,
  bytes: number,
  ageHours: number,
): Promise<void> {
  const file = path.join(cache, `${name}.json`);
  await writeFile(file, Buffer.alloc(bytes, 120)); // 'x'
  const when = new Date(Date.now() - ageHours * 60 * 60 * 1000);
  await utimes(file, when, when);
}

describe("maintainOverpassCache", () => {
  it("unlinks TTL-expired entries and keeps fresh ones", async () => {
    await seedEntry("fresh", 100, 1);
    await seedEntry("stale", 100, 48); // past the 24 h default TTL
    await maintainOverpassCache();
    await expect(readdir(cache)).resolves.toEqual(["fresh.json"]);
  });

  it("evicts oldest-first down to the size budget", async () => {
    // Budget ~1 MB; three 512 KB entries → the two newest survive.
    process.env.DEZFIL_OVERPASS_CACHE_MB = "1";
    await seedEntry("oldest", 512 * 1024, 10);
    await seedEntry("middle", 512 * 1024, 5);
    await seedEntry("newest", 512 * 1024, 1);
    await maintainOverpassCache();
    const left = (await readdir(cache)).sort();
    expect(left).toEqual(["middle.json", "newest.json"]);
  });

  it("touches nothing when the cache is inside its budget", async () => {
    await seedEntry("a", 100, 1);
    await seedEntry("b", 100, 2);
    await maintainOverpassCache();
    expect((await readdir(cache)).sort()).toEqual(["a.json", "b.json"]);
  });
});

describe("fetchOverpass response handling", () => {
  let server: Server;

  function endpoint(): string {
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/interpreter`;
  }

  async function serve(
    handler: (res: import("node:http").ServerResponse) => void,
  ): Promise<void> {
    server = createServer((_req, res) => handler(res));
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));
    process.env.DEZFIL_OVERPASS_URL = endpoint();
  }

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("aborts a response that exceeds the local bound, with a coded error", async () => {
    // Bound = 2 × maxsize; 0.001 MB maxsize → ~2 KB. Serve ~50 KB of JSON.
    process.env.DEZFIL_OVERPASS_MAXSIZE_MB = "0.001";
    await serve((res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(`{"elements":[${'"x",'.repeat(12_000)}"x"]}`);
    });
    await expect(fetchOverpass("[out:json];way;out;")).rejects.toMatchObject({
      code: "remote_too_large",
      status: 413,
    });
    // Nothing over-bound was cached.
    await expect(readdir(cache)).resolves.toEqual([]);
  });

  it("removes a stale cache entry when it is seen, then refetches", async () => {
    process.env.DEZFIL_OVERPASS_CACHE_H = "1";
    const ql = "[out:json];node;out;";
    await serve((res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"elements":[1]}');
    });
    const key = cacheKey(overpassEndpoint(), ql);
    await seedEntry(key, 100, 5); // expired against the 1 h TTL
    const { fromCache } = await fetchOverpass(ql);
    expect(fromCache).toBe(false); // stale entry was not served
    // The refetched response replaced the expired file.
    await expect(readdir(cache)).resolves.toEqual([`${key}.json`]);
  });

  it("serves a fresh entry from cache without touching the network", async () => {
    const ql = "[out:json];rel;out;";
    let hits = 0;
    await serve((res) => {
      hits++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"elements":[]}');
    });
    const first = await fetchOverpass(ql);
    const second = await fetchOverpass(ql);
    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(hits).toBe(1);
  });
});

describe("a refusal from the Overpass endpoint", () => {
  // Seeds in every part of the address that may carry a key.
  const PATH = "/SEEDED-KEY-0001-PATH/api/interpreter";
  const QUERY = "?key=SEEDED-KEY-0001-QUERY";
  const WITHHELD = "Its message is not shown: it repeats part of the address.";
  /** A status refusal whose words were left out: the endpoint as scheme and
   * host, the status, why there are no words, and what to change. */
  const withheld = (origin: string, status: number) =>
    `The Overpass endpoint ${origin} responded ${status}. ${WITHHELD} ${settingRemedy("overpassUrl")}`;
  let server: Server | undefined;

  afterEach(async () => {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  /** A fixture answering every request with one status and a body, fixed or
   * made from the request it answers. */
  async function serve(status: number, body: string | ((req: IncomingMessage) => string) = ""): Promise<string> {
    server = createServer((req, res) => {
      res.writeHead(status, { "content-type": "text/html" });
      res.end(typeof body === "string" ? body : body(req));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async function refusal(address: string): Promise<{ code: string; message: string }> {
    process.env.DEZFIL_OVERPASS_URL = address;
    try {
      await fetchOverpass("[out:json];node;out;");
    } catch (error) {
      return error as { code: string; message: string };
    }
    throw new Error("expected a refusal");
  }

  it("names scheme and host when the endpoint cannot be reached", async () => {
    const origin = await serve(200);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    const refused = await refusal(`${origin}${PATH}${QUERY}`);
    expect(refused.code).toBe("remote_fetch_failed");
    expect(refused.message).toBe(`Could not reach the Overpass endpoint ${origin} (ECONNREFUSED).`);
  });

  it("names scheme and host when the address carries a user and a password", async () => {
    // The user information travels as the request's credentials; a server
    // refusing them, in words that repeat them, is named by scheme and host.
    const origin = await serve(401, "<p><strong>no access for SEEDED-KEY-0001-USER</strong></p>");
    const refused = await refusal(origin.replace("//", "//SEEDED-KEY-0001-USER:SEEDED-KEY-0001-PASS@") + PATH);
    expect(refused.code).toBe("remote_fetch_failed");
    expect(refused.message).toBe(withheld(origin, 401));
  });

  it("names scheme and host when it rate-limits", async () => {
    const origin = await serve(429);
    const refused = await refusal(`${origin}${PATH}${QUERY}`);
    expect(refused.code).toBe("rate_limited");
    expect(refused.message).toContain(`The Overpass endpoint ${origin} rate-limited this request`);
    expect(refused.message).not.toContain("SEEDED-KEY");
  });

  it("drops the server's own words when they repeat the path or the query", async () => {
    for (const echoed of [PATH, "SEEDED-KEY-0001-QUERY", "SEEDED-KEY-0001-PATH"]) {
      const origin = await serve(400, `<p><strong>runtime error: ${echoed} refused</strong></p>`);
      const refused = await refusal(`${origin}${PATH}${QUERY}`);
      expect(refused.message).toBe(withheld(origin, 400));
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
  });

  // A page not found that repeats what it was asked, in a form other than
  // the address as written: the request's path in hex, a query value or a
  // path segment in base64 or UTF-16, the credential the request carried.
  it.each([
    ["the request's path in hex", (req: IncomingMessage) => Buffer.from(req.url ?? "").toString("hex")],
    ["a query value in base64", () => Buffer.from("SEEDED-KEY-0001-QUERY").toString("base64")],
    ["a path segment in base64url", () => Buffer.from("SEEDED-KEY-0001-PATH").toString("base64url")],
    ["the request's path in UTF-16", (req: IncomingMessage) => Buffer.from(req.url ?? "", "utf16le").toString("latin1")],
    ["the Basic credential it was sent", (req: IncomingMessage) => req.headers.authorization ?? ""],
  ])("drops the server's own words when they repeat %s", async (_what, echo) => {
    const origin = await serve(404, (req) => `<p><strong>Not found: ${echo(req)}</strong></p>`);
    const refused = await refusal(origin.replace("//", "//SEEDED-KEY-0001-USER:SEEDED-KEY-0001-PASS@") + PATH + QUERY);
    expect(refused).toMatchObject({ code: "remote_fetch_failed", message: withheld(origin, 404) });
    expect(refused.message).not.toMatch(/SEEDED|Basic|U0VFREVE|5345454445/);
  });

  it("checks the server's whole words before shortening them", async () => {
    // The key straddles the point the words are cut at: what is kept must not
    // be the first half of it.
    const origin = await serve(400, `<p><strong>${"x".repeat(290)} SEEDED-KEY-0001-QUERY</strong></p>`);
    const refused = await refusal(`${origin}${PATH}${QUERY}`);
    expect(refused.message).toBe(withheld(origin, 400));
  });

  it("keeps an error remark that repeats nothing of the address", async () => {
    const origin = await serve(200, JSON.stringify({ elements: [], remark: "runtime error: Query timed out in \"query\" at line 1 after 26 seconds" }));
    const refused = await refusal(`${origin}${PATH}${QUERY}`);
    expect(refused).toMatchObject({ code: "remote_fetch_failed",
      message: "Overpass reported: runtime error: Query timed out in \"query\" at line 1 after 26 seconds. Narrow the area or the tags and retry." });
  });

  it("drops an error remark that repeats the whole address and the credential", async () => {
    const address = (at: string) => at.replace("//", "//SEEDED-KEY-0001-USER:SEEDED-KEY-0001-PASS@") + PATH + QUERY;
    const origin = await serve(200, (req) => JSON.stringify({ elements: [],
      remark: `runtime error: at ${address(`http://${req.headers.host}`)} as ${req.headers.authorization}` }));
    const refused = await refusal(address(origin));
    expect(refused).toMatchObject({ code: "remote_fetch_failed",
      message: `The Overpass endpoint ${origin} responded 200 with an error. ${WITHHELD} Narrow the area or the tags and retry.` });
    expect(refused.message).not.toMatch(/SEEDED|Basic/);
  });

  it("keeps the server's own words when they repeat nothing of the address", async () => {
    const origin = await serve(400, "<p><strong>line 1: parse error: unknown type \"nod\"</strong></p>");
    const refused = await refusal(`${origin}${PATH}${QUERY}`);
    expect(refused.message).toBe(`The Overpass endpoint ${origin} responded 400: line 1: parse error: unknown type "nod"`);
  });
});

describe("the Overpass endpoint under the egress check", () => {
  const QL = "[out:json];node;out;";
  const SEEDED = "/SEEDED-KEY-0001-PATH/api/interpreter?key=SEEDED-KEY-0001-QUERY";
  let fixtures: Server[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.map(fixture => new Promise<void>(resolve => fixture.close(() => resolve()))));
    fixtures = [];
  });

  /** A loopback fixture that records each request it is sent. */
  async function fixture(answer: (res: import("node:http").ServerResponse) => void) {
    const seen: { method?: string; type?: string; agent?: string; body: string }[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        seen.push({ method: req.method, type: req.headers["content-type"], agent: req.headers["user-agent"], body: Buffer.concat(chunks).toString("utf8") });
        answer(res);
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
    fixtures.push(server);
    return { seen, port: (server.address() as AddressInfo).port };
  }
  const answers = (res: import("node:http").ServerResponse) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"elements":[]}'); };

  it("posts the query with its user agent", async () => {
    const overpass = await fixture(answers);
    process.env.DEZFIL_OVERPASS_URL = `http://127.0.0.1:${overpass.port}/api/interpreter`;
    await expect(fetchOverpass(QL)).resolves.toMatchObject({ response: { elements: [] }, fromCache: false });
    expect(overpass.seen).toEqual([{ method: "POST", type: "application/x-www-form-urlencoded",
      agent: "Dezfil/0.1 (self-hosted spatial SQL builder)", body: `data=${encodeURIComponent(QL)}` }]);
  });

  it("refuses an endpoint in loopback space the allowlist does not name, before contact", async () => {
    process.env.DEZFIL_EGRESS_ALLOWLIST = "";
    const overpass = await fixture(answers);
    process.env.DEZFIL_OVERPASS_URL = `http://127.0.0.1:${overpass.port}${SEEDED}`;
    const refused = await fetchOverpass(QL).then(() => null, (error: unknown) => error as { code: string; status: number; message: string });
    expect(refused).toMatchObject({ code: "egress_blocked", status: 403, message: egressBlockedError().message });
    expect(overpass.seen).toEqual([]);
    await expect(readdir(cache)).resolves.toEqual([]);
  });

  it("refuses a redirect into blocked space before contact", async () => {
    // Allowlisted by its literal, the endpoint sends the query on to the
    // unspecified address, which the allowlist does not name.
    const elsewhere = await fixture(answers);
    const overpass = await fixture(res => { res.writeHead(307, { location: `http://0.0.0.0:${elsewhere.port}/api/interpreter` }); res.end(); });
    process.env.DEZFIL_OVERPASS_URL = `http://127.0.0.1:${overpass.port}${SEEDED}`;
    await expect(fetchOverpass(QL)).rejects.toMatchObject({ code: "egress_blocked", status: 403 });
    expect(overpass.seen).toHaveLength(1);
    expect(elsewhere.seen).toEqual([]);
  });
});
