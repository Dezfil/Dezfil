import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "@/lib/api/errors";
import { readAnswer } from "./cache";
import { resetLimiter } from "./limiter";
import { geocodeAddress } from "./provider";

/**
 * One address, answered.
 *
 * **Every case counts requests at the fixture**, because the failure this suite
 * exists to catch is a run that looks right while never reaching the provider —
 * or reaching it twice for one address. A cached test that never touches the
 * seam has produced a false pass in this repository before, so each case
 * asserts what the cache held *before* it ran.
 */

let servers: Server[] = [];
let dir: string;

interface Fixture {
  port: number;
  /** Every request the provider actually received, in order. */
  asked: string[];
}

async function provider(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<Fixture> {
  const asked: string[] = [];
  const server = createServer((req, res) => {
    asked.push(new URL(req.url ?? "", "http://x").searchParams.get("q") ?? "");
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  servers.push(server);
  return { port: (server.address() as AddressInfo).port, asked };
}

const MATCH = [
  {
    display_name: "Alexanderplatz, Berlin, Deutschland",
    lat: "52.5219",
    lon: "13.4132",
    licence: "Data © OpenStreetMap contributors, ODbL 1.0",
  },
];

function answering(body: unknown, status = 200): (req: IncomingMessage, res: ServerResponse) => void {
  return (_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
}

beforeEach(async () => {
  servers = [];
  resetLimiter();
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-geocode-provider-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  process.env.DEZFIL_EGRESS_ALLOWLIST = "127.0.0.1";
  process.env.DEZFIL_GEOCODE_PACE_MS = "0";
});

afterEach(async () => {
  await Promise.all(
    servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
  delete process.env.DEZFIL_DATA_DIR;
  delete process.env.DEZFIL_EGRESS_ALLOWLIST;
  delete process.env.DEZFIL_GEOCODER_URL;
  delete process.env.DEZFIL_GEOCODE_PACE_MS;
  await rm(dir, { recursive: true, force: true });
});

describe("the four row outcomes", () => {
  it("matches, with the point the provider gave and its attribution", async () => {
    const fixture = await provider(answering(MATCH));
    process.env.DEZFIL_GEOCODER_URL = `http://127.0.0.1:${fixture.port}`;
    const answer = await geocodeAddress("Alexanderplatz, Berlin");
    expect(answer.outcome).toBe("matched");
    // Asserted against known numbers rather than "is a number": a transposed
    // axis is exactly the defect this catches, and it passes any shape check.
    expect(answer.lon).toBeCloseTo(13.4132, 4);
    expect(answer.lat).toBeCloseTo(52.5219, 4);
    expect(answer.display).toBe("Alexanderplatz, Berlin, Deutschland");
    expect(answer.attribution).toContain("OpenStreetMap");
    expect(answer.source).toBe("wire");
    expect(fixture.asked).toHaveLength(1);
  });

  it("reads an empty list as no match, and caches it", async () => {
    const fixture = await provider(answering([]));
    process.env.DEZFIL_GEOCODER_URL = `http://127.0.0.1:${fixture.port}`;
    const answer = await geocodeAddress("nowhere at all");
    expect(answer.outcome).toBe("no_match");
    expect(answer.lon).toBeNull();
    expect(answer.source).toBe("wire");
    expect(
      await readAnswer(process.env.DEZFIL_GEOCODER_URL!, "nowhere at all"),
    ).toMatchObject({ outcome: "no_match" });
  });

  it("never asks about an empty address, and never caches one", async () => {
    const fixture = await provider(answering(MATCH));
    process.env.DEZFIL_GEOCODER_URL = `http://127.0.0.1:${fixture.port}`;
    for (const empty of ["", "   ", null, undefined, 42]) {
      const answer = await geocodeAddress(empty);
      expect(answer.outcome).toBe("empty_address");
      // Not `cache`, not `wire` — a row nobody asked about has no source.
      expect(answer.source).toBeNull();
    }
    expect(fixture.asked).toHaveLength(0);
  });

  it("says unreadable rather than no match, and does not cache it", async () => {
    const bodies = ["not json at all", '{"results":[]}', '[{"lat":"x","lon":"y"}]', "[null]"];
    for (const body of bodies) {
      const fixture = await provider(answering(body));
      process.env.DEZFIL_GEOCODER_URL = `http://127.0.0.1:${fixture.port}`;
      const answer = await geocodeAddress("somewhere");
      expect(answer.outcome, body).toBe("unreadable_answer");
      // **The distinction is the point.** Collapsing this into `no_match` would
      // report a provider fault as an address that does not exist — and caching
      // it would keep saying so for a day.
      expect(
        await readAnswer(process.env.DEZFIL_GEOCODER_URL!, "somewhere"),
      ).toBeNull();
    }
  });

  it("keeps a match whose licence is absent, with an empty attribution", async () => {
    const fixture = await provider(
      answering([{ display_name: "Somewhere", lat: 1, lon: 2 }]),
    );
    process.env.DEZFIL_GEOCODER_URL = `http://127.0.0.1:${fixture.port}`;
    const answer = await geocodeAddress("somewhere");
    expect(answer.outcome).toBe("matched");
    expect(answer.attribution).toBeNull();
  });
});

describe("the cache stands between the address and the wire", () => {
  it("answers the second ask from the cache, without a request", async () => {
    const fixture = await provider(answering(MATCH));
    process.env.DEZFIL_GEOCODER_URL = `http://127.0.0.1:${fixture.port}`;
    // The cache is empty before this runs — asserted, not assumed.
    expect(
      await readAnswer(process.env.DEZFIL_GEOCODER_URL, "alexanderplatz, berlin"),
    ).toBeNull();
    const first = await geocodeAddress("Alexanderplatz, Berlin");
    const second = await geocodeAddress("  ALEXANDERPLATZ,   Berlin ");
    expect(first.source).toBe("wire");
    // Two spellings, one address: normalization is what makes this one request.
    expect(second.source).toBe("cache");
    expect(second.lon).toBe(first.lon);
    expect(fixture.asked).toHaveLength(1);
  });

  it("asks under the normalized form, not the typed one", async () => {
    const fixture = await provider(answering(MATCH));
    process.env.DEZFIL_GEOCODER_URL = `http://127.0.0.1:${fixture.port}`;
    await geocodeAddress("  Alexanderplatz,   BERLIN ");
    expect(fixture.asked).toEqual(["alexanderplatz, berlin"]);
  });
});

describe("a transport failure is not a row's business", () => {
  it("retries once, then answers from the second attempt", async () => {
    let calls = 0;
    const fixture = await provider((_req, res) => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(502);
        res.end("upstream is unwell");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(MATCH));
    });
    process.env.DEZFIL_GEOCODER_URL = `http://127.0.0.1:${fixture.port}`;
    const answer = await geocodeAddress("Alexanderplatz, Berlin");
    expect(answer.outcome).toBe("matched");
    expect(fixture.asked).toHaveLength(2);
  });

  it("fails the run when it fails twice, and never says no match", async () => {
    const fixture = await provider(answering("upstream is unwell", 502));
    process.env.DEZFIL_GEOCODER_URL = `http://127.0.0.1:${fixture.port}?key=sekret`;
    const error = await geocodeAddress("Alexanderplatz, Berlin").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("geocoder_failed");
    // Two attempts, and then it stops: the first address's second failure ends
    // the run, with no need to try more rows to find out.
    expect(fixture.asked).toHaveLength(2);
    // The endpoint may carry a key, and this message reaches a job record.
    expect((error as ApiError).message).not.toContain("sekret");
    expect((error as ApiError).message).not.toContain("127.0.0.1");
  });

  it("does not retry a refused egress, and never contacts it", async () => {
    delete process.env.DEZFIL_EGRESS_ALLOWLIST;
    const fixture = await provider(answering(MATCH));
    process.env.DEZFIL_GEOCODER_URL = `http://127.0.0.1:${fixture.port}`;
    const error = await geocodeAddress("Alexanderplatz, Berlin").catch(
      (e: unknown) => e,
    );
    expect((error as ApiError).code).toBe("egress_blocked");
    expect(fixture.asked).toHaveLength(0);
  });

  it("refuses without an endpoint, before anything else happens", async () => {
    const error = await geocodeAddress("Alexanderplatz, Berlin").catch(
      (e: unknown) => e,
    );
    expect((error as ApiError).code).toBe("geocoder_unconfigured");
  });

  it("stops at a cancel rather than retrying it", async () => {
    const fixture = await provider(() => {
      /* Never answers */
    });
    process.env.DEZFIL_GEOCODER_URL = `http://127.0.0.1:${fixture.port}`;
    const controller = new AbortController();
    const pending = geocodeAddress("Alexanderplatz, Berlin", {
      signal: controller.signal,
    }).catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    const error = await pending;
    expect((error as ApiError).code).toBe("remote_fetch_abandoned");
    // One attempt, abandoned — a retry here would keep the provider working on
    // an answer nobody is waiting for.
    expect(fixture.asked).toHaveLength(1);
  });
});
