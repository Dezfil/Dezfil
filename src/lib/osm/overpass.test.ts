import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  cacheKey,
  fetchOverpass,
  maintainOverpassCache,
  overpassEndpoint,
} from "./overpass";

let dir: string;
let cache: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  cache = path.join(dir, "data", "cache", "overpass");
  await mkdir(cache, { recursive: true });
});

afterEach(async () => {
  delete process.env.DEZFIL_DATA_DIR;
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
  let server: Server | undefined;

  afterEach(async () => {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  async function serve(status: number, body = ""): Promise<string> {
    server = createServer((_req, res) => { res.writeHead(status, { "content-type": "text/html" }); res.end(body); });
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
    const origin = await serve(200, "{}");
    const refused = await refusal(origin.replace("//", "//SEEDED-KEY-0001-USER:SEEDED-KEY-0001-PASS@") + PATH);
    expect(refused.code).toBe("remote_fetch_failed");
    expect(refused.message).toContain(`the Overpass endpoint ${origin}`);
    expect(refused.message).not.toContain("SEEDED-KEY");
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
      expect(refused.message).toBe(`The Overpass endpoint ${origin} responded 400`);
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
  });

  it("keeps the server's own words when they repeat nothing of the address", async () => {
    const origin = await serve(400, "<p><strong>line 1: parse error: unknown type \"nod\"</strong></p>");
    const refused = await refusal(`${origin}${PATH}${QUERY}`);
    expect(refused.message).toBe(`The Overpass endpoint ${origin} responded 400: line 1: parse error: unknown type "nod"`);
  });
});
