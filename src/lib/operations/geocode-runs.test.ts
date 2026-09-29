import { testAccountScope, testAccountRequest } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo, Socket } from "node:net";
import path from "node:path";
import { dataDir } from "@/lib/config";
import { resetQueryInstance } from "@/lib/duckdb";
import { importFromUrl } from "@/lib/ingest/remote";
import { refreshTable } from "@/lib/ingest/refresh";
import { resetRefreshFences } from "@/lib/ingest/fence";
import { closeMetadataDb } from "@/lib/metadata/db";
import { getJob } from "@/lib/metadata/jobs";
import { edgesForStep } from "@/lib/metadata/lineage";
import { addStep, createRecipe } from "@/lib/metadata/recipes";
import { deleteTable, getTableByName } from "@/lib/metadata/tables";
import { executeQuery } from "@/lib/query/execute";
import { searchPlaces } from "@/lib/search/provider";
import { endpointKey } from "@/lib/geocode/endpoint";
import { resetLimiter, waitingCount } from "@/lib/geocode/limiter";
import { laneSettled, resetLane } from "./lane";
import { readStep } from "./recipe-view";
import { cancelRun, startRun } from "./run";
import { startStepRun } from "./step-execution";

/**
 * Geocoding end to end, through the real lane against a fixture provider.
 *
 * **Everything asserted here is asserted at the fixture or in the registry**,
 * never inferred from the job's own story. A run that reported success while
 * asking twice, or asking after it was cancelled, or publishing a staging path,
 * satisfies every claim a job's state can make.
 */

let dir: string;
let server: Server;
let base: string;
/** Every question the provider was asked, in order, with when it arrived. */
let asked: { q: string; at: number }[];
/** Sockets the provider is still holding, so a cancel can be seen to close one. */
let held: Socket[];
let closed: number;
/** Swapped by a test that needs a slow or silent provider. */
let handler: ((req: IncomingMessage, res: ServerResponse) => void) | null;

const ADDRESSES = () =>
  [
    "label,address",
    "a,Alexanderplatz",
    "b,Alexanderplatz",
    "c,nowhere at all",
    "d,",
    "e,unreadable",
  ].join("\n") + "\n";

/** Unique addresses, so nothing is answered from a cache another test filled. */
const MANY = (n: number) =>
  ["label,address", ...Array.from({ length: n }, (_, i) => `p${i},place ${i}`)].join(
    "\n",
  ) + "\n";

const CONFIGURED_PACE_MS = 150;
// Keep the proof floor independent from the environment knob: changing only
// the configured pace to zero is the seeded defect, and must leave a failing
// assertion behind rather than editing the expectation with its input.
const PACE_FLOOR_MS = 150;
const PACE_SLACK_MS = 15;

function answerFor(query: string): string {
  if (query.startsWith("unreadable")) return "this is not JSON";
  if (query.includes("alexanderplatz") || query.startsWith("place ")) {
    return JSON.stringify([
      {
        display_name: "Alexanderplatz, Berlin",
        lat: "52.5219",
        lon: "13.4132",
        licence: "ODbL",
      },
    ]);
  }
  return "[]";
}

beforeEach(async () => {
  resetLane();
  resetLimiter();
  resetRefreshFences();
  asked = [];
  held = [];
  closed = 0;
  handler = null;
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-geocode-runs-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  process.env.DEZFIL_EGRESS_ALLOWLIST = "127.0.0.1";
  process.env.DEZFIL_GEOCODE_PACE_MS = "0";
  closeMetadataDb();
  resetQueryInstance();

  server = createServer((req, res) => {
    const url = new URL(req.url ?? "", "http://x");
    // The same fixture serves the source CSV, so the addresses can be a real
    // remote import — which is what makes a refresh a real generation change.
    if (url.pathname.endsWith(".csv")) {
      res.writeHead(200, { "content-type": "text/csv" });
      res.end(url.pathname.includes("many") ? MANY(6) : ADDRESSES());
      return;
    }
    asked.push({ q: url.searchParams.get("q") ?? "", at: Date.now() });
    if (handler) {
      handler(req, res);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(answerFor(url.searchParams.get("q") ?? ""));
  });
  server.on("connection", (socket) => {
    held.push(socket);
    socket.on("close", () => {
      closed += 1;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.DEZFIL_GEOCODER_URL = base;
  await importFromUrl(testAccountScope(), `${base}/addresses.csv`, "addresses");
});

afterEach(async () => {
  resetLane();
  resetLimiter();
  closeMetadataDb();
  resetQueryInstance();
  for (const socket of held) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.DEZFIL_DATA_DIR;
  delete process.env.DEZFIL_EGRESS_ALLOWLIST;
  delete process.env.DEZFIL_GEOCODER_URL;
  delete process.env.DEZFIL_GEOCODE_PACE_MS;
  delete process.env.DEZFIL_OPERATION_CONCURRENCY;
  delete process.env.DEZFIL_OPERATION_TIMEOUT_S;
  await rm(dir, { recursive: true, force: true });
});

async function run(parameters: Record<string, unknown>) {
  const job = await startRun(testAccountScope(), { operation: "geocode_addresses", parameters });
  await laneSettled();
  return getJob(job.id)!;
}

const located = () =>
  executeQuery(
    `SELECT label, geocode_status, geocode_source, geocode_match,
            geocode_attribution, ST_X(geom) AS x, ST_Y(geom) AS y
     FROM located ORDER BY label`,
  );

/** Staging artifacts still on disk, by the name the sweep would recognise. */
async function stages(): Promise<string[]> {
  const entries = await readdir(path.join(dataDir(), "tables")).catch(() => []);
  return entries.filter((name) => name.startsWith("geocode-stage-"));
}

async function until(condition: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("one row out for every row in", () => {
  it("answers five rows, four outcomes, and one request for the repeat", async () => {
    const job = await run({ input: "addresses", column: "address", name: "located" });
    expect(job.state, job.errorMessage ?? "").toBe("succeeded");

    const columns = (
      await executeQuery("SELECT * FROM (DESCRIBE SELECT * FROM located)")
    ).preview.map((r) => String(r.column_name));
    // The exact column list, so a stray column fails rather than passing a
    // containment check — the original columns, untouched, then the five.
    expect(columns).toEqual([
      "label",
      "address",
      "geom",
      "geocode_status",
      "geocode_match",
      "geocode_attribution",
      "geocode_source",
    ]);

    const rows = (await located()).preview as Record<string, unknown>[];
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.geocode_status)).toEqual([
      "matched",
      "matched",
      "no_match",
      "empty_address",
      "unreadable_answer",
    ]);
    // Four distinct outcomes, and the repeat shares the match's answer.
    expect(new Set(rows.map((r) => r.geocode_status)).size).toBe(4);
    // Known longitude and latitude: a transposed axis fails here.
    expect(Number(rows[0].x)).toBeCloseTo(13.4132, 4);
    expect(Number(rows[0].y)).toBeCloseTo(52.5219, 4);
    expect(Number(rows[1].x)).toBeCloseTo(13.4132, 4);
    // The empty row was never asked about, so it has no source at all.
    expect(rows[3].geocode_source).toBeNull();
    expect(rows[3].geocode_match).toBeNull();
    // Three questions for five rows: the repeat is the same value, so it is
    // the same stage row and the same single request.
    expect(asked.map((a) => a.q).sort()).toEqual([
      "alexanderplatz",
      "nowhere at all",
      "unreadable",
    ]);
    // And the registry classifies it by what it holds, not by its holes.
    expect(getTableByName("located")!.geometryType).toBe("POINT");
    expect(getTableByName("located")!.geometryColumn).toBe("geom");
  });

  it("keeps no staging artifact after a run that succeeded", async () => {
    await run({ input: "addresses", column: "address", name: "located" });
    expect(await stages()).toEqual([]);
  });
});

describe("what the publication records", () => {
  it("names the source as its input, and carries a disclosure and no SQL", async () => {
    await run({ input: "addresses", column: "address", name: "located" });
    const source = getTableByName("addresses")!;
    const output = getTableByName("located")!;
    const provenance = output.sourceParams as Record<string, unknown>;

    // The lineage is the original input, not the stage.
    expect(provenance.inputs).toEqual([{ id: source.id, name: source.name }]);
    // No SQL at all — an absence, not a redaction that must never miss.
    expect(provenance.sql).toBeUndefined();
    const disclosure = provenance.disclosure as Record<string, unknown>;
    expect(disclosure).toMatchObject({
      kind: "provider_request",
      endpoint: base,
      fromWire: 3,
      fromCache: 0,
      // Distinct addresses the run answered — the NULL row is not an address,
      // and the repeat is not a second one.
      addresses: 3,
    });
    expect(disclosure.attributions).toEqual(["ODbL"]);
    // The staging path appears nowhere in what was published.
    expect(JSON.stringify(provenance)).not.toContain("geocode-stage-");
  });

  it("shows the same request on the run's own resource", async () => {
    // Criterion 14 names three surfaces, and the run resource is one of them:
    // a caller polling `/api/operations/runs/:id` sees what was asked without
    // having to know which table to look in. Read from the **job's own row**,
    // which the test below is about.
    const job = await run({
      input: "addresses",
      column: "address",
      name: "located",
    });
    const { jobView } = await import("./job-view");
    const view = jobView(job);
    expect(view.disclosure).toMatchObject({
      kind: "provider_request",
      endpoint: base,
      fromWire: 3,
    });
    // An ordinary run carries none: its evidence is the SQL its output holds.
    const plain = await startRun(testAccountScope(), {
      operation: "sql_step",
      parameters: { sql: "SELECT 1 AS n", name: "plain" },
    });
    await laneSettled();
    expect(jobView(getJob(plain.id)!).disclosure).toBeUndefined();
  });

  it("keeps each run's own disclosure when a later run replaces the output", async () => {
    /**
     * **A run's disclosure belongs to the run, not to the table it wrote.**
     *
     * Reading it back from the output's provenance looked equivalent and was
     * not: a re-run replaces that output in place, so every older job then
     * reported the newest run's cache and wire counts — a durable record of
     * what was asked, quietly rewritten by a later question. Found at the
     * cross-model review.
     *
     * The two runs are distinguishable by construction: the first asks the
     * provider for all three, the second finds two in the cache and re-asks
     * the one that was an unreadable answer — a provider fault is never
     * cached, which is the rule's second conjunct showing up here as the
     * thing that makes the two records tell different stories.
     */
    const { jobView } = await import("./job-view");
    const first = await run({
      input: "addresses",
      column: "address",
      name: "twice",
    });
    expect(jobView(first).disclosure).toMatchObject({ fromWire: 3, fromCache: 0 });

    // Replace the same dataset from a second run, which the warm cache answers.
    deleteTable("twice");
    const second = await run({
      input: "addresses",
      column: "address",
      name: "twice",
    });
    expect(jobView(second).disclosure).toMatchObject({ fromWire: 1, fromCache: 2 });

    // And the first run still says what the first run asked.
    expect(jobView(getJob(first.id)!).disclosure).toMatchObject({
      fromWire: 3,
      fromCache: 0,
    });
  });

  it("records the edge at the source's exact artifact, and goes stale with it", async () => {
    const recipe = createRecipe(testAccountScope(), "R");
    const step = addStep(recipe.id, {
      operation: "geocode_addresses",
      parameters: { input: "addresses", column: "address", name: "located" },
    });
    const job = await startStepRun(testAccountScope(), step.id).then(async (j) => {
      await laneSettled();
      return getJob(j.id)!;
    });
    expect(job.state, job.errorMessage ?? "").toBe("succeeded");

    const before = getTableByName("addresses")!.file;
    const edges = edgesForStep(step.id);
    expect(edges).toHaveLength(1);
    // The artifact, not merely the identity: staleness is a generation
    // mismatch, and an edge that recorded only the name could not see one.
    expect(edges[0].boundArtifact).toBe(before);
    expect((await readStep(recipe.id, step.id)).condition.primary).toBe("current");

    // A new generation of the source underneath it.
    await refreshTable("addresses");
    expect(getTableByName("addresses")!.file).not.toBe(before);
    const condition = (await readStep(recipe.id, step.id)).condition;
    expect(condition.primary).toBe("stale");
    expect(condition.causes.map((c) => c.reason)).toContain("source_changed");
  });
});

describe("the fence, in its own words", () => {
  it("refuses a source replaced mid-run, and publishes nothing", async () => {
    // Slow enough that the source can be replaced while the provider phase is
    // still going — and the change is made only once a request has actually
    // been seen, so the run is provably past its input capture.
    handler = (req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          answerFor(
            new URL(req.url ?? "", "http://x").searchParams.get("q") ?? "",
          ),
        );
      }, 250);
    };
    const job = await startRun(testAccountScope(), {
      operation: "geocode_addresses",
      parameters: { input: "addresses", column: "address", name: "located" },
    });
    await until(() => asked.length >= 1);
    await refreshTable("addresses");
    await laneSettled();

    const settled = getJob(job.id)!;
    expect(settled.state).toBe("failed");
    // **About the input having changed** — not about a projection, which is
    // true for a buffer and nonsense for a run that measured nothing.
    expect(settled.errorCode).toBe("input_changed");
    expect(settled.errorMessage).toMatch(/replaced while this run was working/);
    expect(settled.errorMessage).not.toMatch(/projection/);
    expect(getTableByName("located")).toBeNull();
    expect(await stages()).toEqual([]);
  });
});

describe("the run's bounds", () => {
  /**
   * **One budget, and publication gets what is left of it.**
   *
   * Proven with a preparation that only sleeps, rather than with the geocoder:
   * an *admitted* batch fits its budget by construction — that is what the
   * derived bound is for — so a real batch can only overrun by a provider
   * breaking its own per-request deadline, which is a different failure. What
   * has to be proven here is the arithmetic: a publication handed a fresh
   * budget would give a slow run twice the time it was promised, and this is
   * the only place that shows.
   */
  it("hands publication what is left of the budget, not a fresh one", async () => {
    process.env.DEZFIL_OPERATION_TIMEOUT_S = "1";
    let cleaned = 0;
    const { submitRun } = await import("./run");

    const slow = submitRun(testAccountScope(), {
      operationId: "sql_step",
      parameters: {},
      sql: "",
      name: "too_late",
      prepare: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_300));
        return {
          sql: "SELECT 1 AS n",
          disclosure: { kind: "provider_request" },
          cleanup: async () => {
            cleaned += 1;
          },
        };
      },
    });
    await laneSettled();
    const settled = getJob(slow.id)!;
    expect(settled.state).toBe("failed");
    expect(settled.errorCode).toBe("operation_timeout");
    expect(getTableByName("too_late")).toBeNull();
    // The staging a preparation owns goes even when the run it belonged to
    // never published.
    expect(cleaned).toBe(1);

    // The control: the same publication, with a preparation that costs
    // nothing, succeeds — so the failure above is the budget and not the SQL.
    const quick = submitRun(testAccountScope(), {
      operationId: "sql_step",
      parameters: {},
      sql: "",
      name: "in_time",
      prepare: async () => ({
        sql: "SELECT 1 AS n",
        disclosure: { kind: "provider_request" },
        cleanup: async () => {
          cleaned += 1;
        },
      }),
    });
    await laneSettled();
    expect(getJob(quick.id)!.state, getJob(quick.id)!.errorMessage ?? "").toBe(
      "succeeded",
    );
    expect(getTableByName("in_time")).not.toBeNull();
    expect(cleaned).toBe(2);
  });

  it("cancelling closes the exchange in flight and registers nothing", async () => {
    // A provider that accepts the connection and never answers.
    handler = () => {};
    const job = await startRun(testAccountScope(), {
      operation: "geocode_addresses",
      parameters: { input: "addresses", column: "address", name: "located" },
    });
    await until(() => asked.length >= 1);
    const closedBefore = closed;

    await cancelRun(job.id);
    // **Observed at the fixture**: the connection closes, rather than the job
    // merely reporting itself cancelled while the socket runs to its deadline.
    await until(() => closed > closedBefore);
    await laneSettled(); // the lane's slot is released

    expect(getJob(job.id)!.state).toBe("cancelled");
    expect(getTableByName("located")).toBeNull();
    expect(await stages()).toEqual([]);
    const after = asked.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(asked).toHaveLength(after);
  });
});

describe("the pace is the instance's", () => {
  it("holds one interval between requests from two batches at once", async () => {
    process.env.DEZFIL_GEOCODE_PACE_MS = String(CONFIGURED_PACE_MS);
    process.env.DEZFIL_OPERATION_CONCURRENCY = "2";
    resetLane();
    resetLimiter();
    await importFromUrl(testAccountScope(), `${base}/many.csv`, "many");
    // Two runs over inputs with no cached answers between them, genuinely
    // overlapping in the lane.
    const first = startRun(testAccountScope(), {
      operation: "geocode_addresses",
      parameters: { input: "many", column: "address", name: "one" },
    });
    const second = startRun(testAccountScope(), {
      operation: "geocode_addresses",
      parameters: { input: "addresses", column: "address", name: "two" },
    });
    await Promise.all([first, second]);
    await laneSettled();

    // Measured, not mocked, from request starts at the fixture. Anchor every
    // request to the first sample: runner load can only lengthen a cumulative
    // span, while adjacent samples can bunch after a stall. Every index holds
    // its own cumulative pace floor whichever run the request belongs to; the
    // independent floor keeps neutralizing the configured pace red-provable.
    const times = asked.map((a) => a.at);
    expect(times.length).toBeGreaterThanOrEqual(6);
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i] - times[0]).toBeGreaterThanOrEqual(
        i * PACE_FLOOR_MS - PACE_SLACK_MS,
      );
    }
  });

  it("lets an interactive search take the next slot, ahead of a waiting batch", async () => {
    process.env.DEZFIL_GEOCODE_PACE_MS = "300";
    resetLimiter();
    await importFromUrl(testAccountScope(), `${base}/many.csv`, "many");
    const job = startRun(testAccountScope(), {
      operation: "geocode_addresses",
      parameters: { input: "many", column: "address", name: "one" },
    });
    // Wait until the batch is genuinely queued for its *next* slot: a search
    // that arrives before that has nothing to overtake, and the test would
    // prove nothing.
    const key = endpointKey(base);
    await until(() => asked.length >= 1 && waitingCount(key) >= 1);
    await searchPlaces("a search someone typed");

    // The next request the provider saw is the search's, not the batch's.
    expect(asked[1].q).toBe("a search someone typed");
    await job;
    await laneSettled();
  });
});

describe("the cache makes a second run cheap", () => {
  /**
   * **The absolute conjunct gets its own fixture.** Criterion 9 says a second
   * run makes *no* provider requests, and the five-row fixture cannot show
   * that: it holds an answer the cache deliberately never keeps, so its rerun
   * legitimately asks once. A test asserting "one" under a title promising
   * "none" is the overclaim this repository keeps catching at review — so the
   * zero case runs over addresses that are all cacheable, and the unreadable
   * one is the *resumed* case below, where asking again is the point.
   */
  it("makes no request at all on a second run over cacheable answers", async () => {
    await importFromUrl(testAccountScope(), `${base}/many.csv`, "many");
    await run({ input: "many", column: "address", name: "located" });
    const first = asked.length;
    expect(first).toBe(6);

    await run({ input: "many", column: "address", name: "again" });
    expect(asked.length).toBe(first);
    // And the second run's rows say where they came from.
    const sources = (
      await executeQuery("SELECT DISTINCT geocode_source FROM again")
    ).preview.map((r) => r.geocode_source);
    expect(sources).toEqual(["cache"]);
  }, 30_000);

  it("asks only for what it lacks — the answer the cache never keeps", async () => {
    await run({ input: "addresses", column: "address", name: "located" });
    const first = asked.length;
    expect(first).toBe(3);

    await run({ input: "addresses", column: "address", name: "again" });
    // One question: the unreadable answer is a provider fault and likely
    // transient, so it is never cached and is asked again. The match and the
    // no-match are held.
    expect(asked.length - first).toBe(1);
    expect(asked[asked.length - 1].q).toBe("unreadable");
  }, 30_000);

  it("goes to the wire only for addresses it has never answered", async () => {
    await run({ input: "addresses", column: "address", name: "located" });
    const before = asked.length;
    await importFromUrl(testAccountScope(), `${base}/many.csv`, "many");
    await run({ input: "many", column: "address", name: "more" });
    // Six new addresses, six questions — nothing the first run answered is
    // among them, and nothing is asked twice.
    expect(asked.length - before).toBe(6);
    const third = (
      await executeQuery(
        "SELECT geocode_source FROM more WHERE geocode_status = 'matched'",
      )
    ).preview;
    expect(third.every((r) => r.geocode_source === "wire")).toBe(true);
  }, 30_000);
});

describe("a dry run touches nobody", () => {
  it("answers the admitted row count and the fixed point output, asking nothing", async () => {
    const { POST } = await import("@/app/api/operations/run/route");
    const response = await POST(
      testAccountRequest(new Request("http://test/api/operations/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: "geocode_addresses",
          dryRun: true,
          parameters: { input: "addresses", column: "address" },
        }),
      })),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      dryRun: { rowCount: number; geometryType: string; geometry: string };
    };
    // One row out for every row in, which is knowable before a single request.
    expect(body.dryRun.rowCount).toBe(5);
    expect(body.dryRun.geometryType).toBe("POINT");
    expect(body.dryRun.geometry).toBe("classified");
    // **Zero requests at the fixture** — the whole point of a dry run here.
    expect(asked).toHaveLength(0);
    expect(await stages()).toEqual([]);
  });
});

describe("run-wide failures, one at a time", () => {
  it("refuses an unconfigured endpoint before a job exists", async () => {
    delete process.env.DEZFIL_GEOCODER_URL;
    await expect(
      startRun(testAccountScope(), {
        operation: "geocode_addresses",
        parameters: { input: "addresses", column: "address", name: "located" },
      }),
    ).rejects.toMatchObject({ code: "geocoder_unconfigured" });
    expect(getTableByName("located")).toBeNull();
  });

  it("fails the run when egress is denied, and writes nothing", async () => {
    delete process.env.DEZFIL_EGRESS_ALLOWLIST;
    const job = await run({ input: "addresses", column: "address", name: "located" });
    expect(job.state).toBe("failed");
    expect(job.errorCode).toBe("egress_blocked");
    expect(getTableByName("located")).toBeNull();
    expect(await stages()).toEqual([]);
  });

  it("fails the run when the provider fails twice on the first address", async () => {
    handler = (_req, res) => {
      res.writeHead(503);
      res.end("no");
    };
    const job = await run({ input: "addresses", column: "address", name: "located" });
    expect(job.state).toBe("failed");
    expect(job.errorCode).toBe("geocoder_failed");
    // The first address's second failure ends it — no need to try the rest.
    expect(asked).toHaveLength(2);
    expect(getTableByName("located")).toBeNull();
    expect(await stages()).toEqual([]);
  });

  it("succeeds when only individual rows fail, publishing the accounting", async () => {
    const job = await run({ input: "addresses", column: "address", name: "located" });
    expect(job.state).toBe("succeeded");
    const statuses = (await located()).preview.map((r) => r.geocode_status);
    expect(statuses).toContain("no_match");
    expect(statuses).toContain("unreadable_answer");
    expect(statuses).toContain("empty_address");
  });
});

describe("nothing the provider was told is recoverable", () => {
  it("keeps a key out of the registry, the job, and the cache's file names", async () => {
    process.env.DEZFIL_GEOCODER_URL = `${base}?key=sekret`;
    const job = await run({ input: "addresses", column: "address", name: "located" });
    expect(job.state, job.errorMessage ?? "").toBe("succeeded");

    const provenance = JSON.stringify(getTableByName("located")!.sourceParams);
    expect(provenance).not.toContain("sekret");
    // The identity that *is* published is host and path, which is the contract
    // rather than an accident of this fixture having no path.
    expect(provenance).toContain(base);
    expect(JSON.stringify(job)).not.toContain("sekret");

    const cacheFiles = await readdir(
      path.join(dataDir(), "cache", "geocode"),
    ).catch(() => []);
    expect(cacheFiles.length).toBeGreaterThan(0);
    expect(cacheFiles.join(" ")).not.toContain("sekret");
  });

  it("keeps it out of a failure's words too", async () => {
    process.env.DEZFIL_GEOCODER_URL = `${base}?key=sekret`;
    handler = (_req, res) => {
      res.writeHead(500);
      res.end("no");
    };
    const job = await run({ input: "addresses", column: "address", name: "located" });
    expect(job.state).toBe("failed");
    expect(job.errorMessage).not.toContain("sekret");
    expect(job.errorMessage).not.toContain("127.0.0.1");
  });
});
