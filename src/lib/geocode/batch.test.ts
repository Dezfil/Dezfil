import { testAccountScope } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "@/lib/api/errors";
import { dataDir } from "@/lib/config";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { closeMetadataDb } from "@/lib/metadata/db";
import { getTableByName } from "@/lib/metadata/tables";
import { executeQuery } from "@/lib/query/execute";
import { stageBatch, publicationSql, removeStage } from "./batch";
import { resetLimiter } from "./limiter";

/**
 * The batch, against a fixture provider.
 *
 * **Requests are counted at the fixture, never inferred from the answers.** The
 * claims this suite makes — one request per distinct address, none after the
 * deadline, none after a cancel — are all claims about what the provider saw,
 * and a batch that answered correctly while asking twice would satisfy every
 * assertion about its output.
 */

let servers: Server[] = [];
let dir: string;
let asked: string[];

async function provider(
  handler?: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<number> {
  const server = createServer((req, res) => {
    const q = new URL(req.url ?? "", "http://x").searchParams.get("q") ?? "";
    asked.push(q);
    if (handler) {
      handler(req, res);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(answerFor(q)));
  });
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

/** A provider that knows two addresses and nothing else. */
function answerFor(query: string): unknown[] {
  if (query.includes("alexanderplatz")) {
    return [
      {
        display_name: "Alexanderplatz, Berlin",
        lat: "52.5219",
        lon: "13.4132",
        licence: "ODbL",
      },
    ];
  }
  if (query.includes("brandenburger")) {
    return [
      {
        display_name: "Brandenburger Tor, Berlin",
        lat: "52.5163",
        lon: "13.3777",
        licence: "ODbL",
      },
    ];
  }
  return [];
}

/**
 * Six rows and five distinct values, with both shapes of "nothing to ask
 * about": a column the importer read as NULL (`f`) and a value that is a string
 * of nothing (`g`). They reach the answer by different roads — one misses the
 * join, one is staged as an outcome — and both must read as `empty_address`.
 */
const CSV = [
  "label,address",
  "a,Alexanderplatz",
  "b,  ALEXANDERPLATZ ",
  "c,Alexanderplatz",
  "d,Brandenburger Tor",
  "e,nowhere at all",
  "f,",
  'g," "',
].join("\n");

async function ingest(): Promise<void> {
  await writeFile(path.join(dir, "places.csv"), `${CSV}\n`);
  await ingestFile(testAccountScope(), path.join(dir, "places.csv"), "places.csv");
}

const NEVER_TIMES_OUT = () => new ApiError("operation_timeout", "too slow", 408);

beforeEach(async () => {
  servers = [];
  asked = [];
  resetLimiter();
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-geocode-batch-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  process.env.DEZFIL_EGRESS_ALLOWLIST = "127.0.0.1";
  process.env.DEZFIL_GEOCODE_PACE_MS = "0";
  closeMetadataDb();
  resetQueryInstance();
  await ingest();
});

afterEach(async () => {
  await Promise.all(
    servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  delete process.env.DEZFIL_EGRESS_ALLOWLIST;
  delete process.env.DEZFIL_GEOCODER_URL;
  delete process.env.DEZFIL_GEOCODE_PACE_MS;
  await rm(dir, { recursive: true, force: true });
});

async function stage(signal?: AbortSignal, deadlineAt = Date.now() + 30_000) {
  return stageBatch(testAccountScope(), {
    table: getTableByName("places")!,
    column: "address",
    ...(signal ? { signal } : {}),
    deadlineAt,
    timeoutError: NEVER_TIMES_OUT,
  });
}

describe("what the batch asks, and what it stages", () => {
  it("asks once per distinct address and stages one row for each value", async () => {
    process.env.DEZFIL_GEOCODER_URL = `http://127.0.0.1:${await provider()}`;
    const result = await stage();

    // Five distinct values worth staging: two spellings of Alexanderplatz, the
    // Tor, the nonsense one, and the string of nothing. The NULL is not one —
    // a NULL cannot be a join key, so it reaches its outcome by missing.
    expect(result.staged).toBe(5);
    // Three questions: the repeat of an identical value is not a second value,
    // the second *spelling* is answered from the cache the first wrote, and the
    // string of nothing is never a question at all.
    expect([...asked].sort()).toEqual([
      "alexanderplatz",
      "brandenburger tor",
      "nowhere at all",
    ]);
    expect(result.disclosure.fromWire).toBe(3);
    expect(result.disclosure.fromCache).toBe(1);
    expect(result.disclosure.attributions).toEqual(["ODbL"]);
    expect(result.disclosure.normalization).toBeGreaterThan(0);
    // Host and path, never the query string.
    expect(result.disclosure.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("publishes one row per input row, with the documented columns", async () => {
    process.env.DEZFIL_GEOCODER_URL = `http://127.0.0.1:${await provider()}`;
    const result = await stage();
    const table = getTableByName("places")!;
    const answer = await executeQuery(testAccountScope(),
      `SELECT label, geocode_status, geocode_source, geocode_match,
              geocode_attribution, ST_X(geom) AS x, ST_Y(geom) AS y
       FROM (${publicationSql(table, "address", result.stage)}) ORDER BY label`,
    );
    const rows = answer.preview as Record<string, unknown>[];
    expect(rows).toHaveLength(7);
    expect(rows.map((r) => r.geocode_status)).toEqual([
      "matched",
      "matched",
      "matched",
      "matched",
      "no_match",
      // Both roads to "nothing to ask about" arrive at the same outcome.
      "empty_address",
      "empty_address",
    ]);
    // Known longitude and latitude, so a transposed axis fails here.
    expect(Number(rows[0].x)).toBeCloseTo(13.4132, 4);
    expect(Number(rows[0].y)).toBeCloseTo(52.5219, 4);
    // **The two spellings share one answer, and only one of them cost a
    // request.** Which one reaches the wire is the batch's own ordering and not
    // this assertion's business; that they agree on the point, and that exactly
    // one of them was asked, is.
    expect(rows[0].geocode_source).toBe(rows[2].geocode_source); // same value
    expect(
      [rows[0].geocode_source, rows[1].geocode_source].sort(),
    ).toEqual(["cache", "wire"]);
    expect(Number(rows[1].x)).toBeCloseTo(Number(rows[0].x), 6);
    expect(Number(rows[2].y)).toBeCloseTo(Number(rows[0].y), 6);
    // A row nobody asked about has no source at all — not `cache`, not `wire`.
    expect(rows[5].geocode_source).toBeNull();
    expect(rows[6].geocode_source).toBeNull();
    expect(rows[5].geocode_match).toBeNull();
    expect(rows[4].geocode_match).toBeNull();
    expect(rows[0].geocode_match).toBe("Alexanderplatz, Berlin");
    // Nothing was drawn for a row that did not match.
    expect(rows[4].x).toBeNull();
  });

  it("leaves the original columns untouched", async () => {
    process.env.DEZFIL_GEOCODER_URL = `http://127.0.0.1:${await provider()}`;
    const result = await stage();
    const table = getTableByName("places")!;
    const described = await executeQuery(testAccountScope(),
      `SELECT * FROM (DESCRIBE SELECT * FROM (${publicationSql(
        table,
        "address",
        result.stage,
      )}))`,
    );
    expect(described.preview.map((r) => String(r.column_name))).toEqual([
      "label",
      "address",
      "geom",
      "geocode_status",
      "geocode_match",
      "geocode_attribution",
      "geocode_source",
    ]);
  });
});

describe("the run's own bounds reach the wire", () => {
  it("starts no request once the deadline has passed", async () => {
    process.env.DEZFIL_GEOCODER_URL = `http://127.0.0.1:${await provider()}`;
    // A deadline already gone: the source read is what fails, and the provider
    // is never contacted at all.
    const error = await stage(undefined, Date.now() - 1).catch(
      (e: unknown) => e,
    );
    expect((error as ApiError).code).toBe("operation_timeout");
    expect(asked).toHaveLength(0);
  });

  it("stops between rows when the deadline lands mid-batch", async () => {
    // A provider that takes 1.5 s to answer, against a deadline that allows
    // one or two answers and not four. The numbers are ten times what they
    // were: the claim is about ordering (an ask before the deadline, none
    // after), and the tolerance for the source read and scheduling before
    // the first ask is the deadline minus two answers. At 150 ms / 300 ms
    // that tolerance was 300 ms, and the shared CI runner spent more than
 // that before the first ask (a run 36156579821: no ask at
    // all). At 1.5 s / 3 s it is 3 s.
    //
    // **The pace is genuinely zero here**, which it was not before: `fromEnv`
    // rejected a zero and handed back the one-second default, so this test used
    // to time out on pacing rather than on the provider — passing for a reason
    // that had nothing to do with what it names. Found at the cross-model
    // review, in the finding that made the setting work.
    process.env.DEZFIL_GEOCODER_URL = `http://127.0.0.1:${await provider(
      (req, res) => {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify(
              answerFor(
                new URL(req.url ?? "", "http://x").searchParams.get("q") ?? "",
              ),
            ),
          );
        }, 1500);
      },
    )}`;
    const error = await stage(undefined, Date.now() + 3000).catch(
      (e: unknown) => e,
    );
    expect((error as ApiError).code).toBe("operation_timeout");
    // It asked for something before it ran out, and it stopped asking after.
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.length).toBeLessThan(3);
    const before = asked.length;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(asked).toHaveLength(before);
  });

  /**
   * **The wait for a slot is where a deadline gets crossed**.
   *
   * The batch checks its budget before deciding to ask, and then queues behind
   * the instance's pace. Without the deadline travelling into the lookup, the
   * slot opens after the run is over, the request goes out anyway, and it then
   * takes its own full deadline on top of a budget already spent. Found at the
   * cross-model review.
   */
  it("starts no request whose slot opened after the deadline", async () => {
    // A pace longer than what is left of the budget: the first question goes
    // out at once, and the second one's slot cannot open before the run is
    // over. The batch's own between-rows check passes — it is inside the
    // budget when it decides to ask — so this is the case only the near side
    // of the wait can catch. Sized like the case above: the first ask must
    // leave before the deadline, so the tolerance for what precedes it is
    // the whole deadline; 2.5 s here where 700 ms was the shared runner's
    // margin, and the trailing wait outlasts the slot's opening.
    process.env.DEZFIL_GEOCODE_PACE_MS = "3000";
    resetLimiter();
    process.env.DEZFIL_GEOCODER_URL = `http://127.0.0.1:${await provider()}`;
    const error = await stage(undefined, Date.now() + 2500).catch(
      (e: unknown) => e,
    );
    expect((error as ApiError).code).toBe("operation_timeout");
    expect(asked).toHaveLength(1);
    // The slot opens while nothing is watching; it must not become a request.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(asked).toHaveLength(1);
  });

  it("leaves no staging artifact behind when it fails", async () => {
    process.env.DEZFIL_GEOCODER_URL = `http://127.0.0.1:${await provider(
      (_req, res) => {
        res.writeHead(503);
        res.end("no");
      },
    )}`;
    const error = await stage().catch((e: unknown) => e);
    expect((error as ApiError).code).toBe("geocoder_failed");
    expect(await stagesLeft()).toEqual([]);
  });

  it("removes its stage on request, for a run that is over", async () => {
    process.env.DEZFIL_GEOCODER_URL = `http://127.0.0.1:${await provider()}`;
    const result = await stage();
    expect(await stagesLeft()).toHaveLength(1);
    await removeStage(result.stage);
    expect(await stagesLeft()).toEqual([]);
  });
});

/** Staging artifacts in the artifact directory, by their own recognisable
 * name — the boot sweep's backstop is what collects any this misses. */
async function stagesLeft(): Promise<string[]> {
  const entries = await readdir(path.join(dataDir(), "tables")).catch(() => []);
  return entries.filter((name) => name.startsWith("geocode-stage-"));
}
