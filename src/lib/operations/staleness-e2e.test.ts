import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { importFromUrl } from "@/lib/ingest/remote";
import { refreshTable } from "@/lib/ingest/refresh";
import { resetRefreshFences } from "@/lib/ingest/fence";
import { getJob } from "@/lib/metadata/jobs";
import { addStep, createRecipe, editStep } from "@/lib/metadata/recipes";
import { startStepRun } from "./step-execution";
import { readRecipe, readStep } from "./recipe-view";
import { laneSettled, resetLane } from "./lane";
import type { StaleCause } from "./staleness";

/**
 * Staleness against a real refresh.
 *
 * The derivation is a pure function and is unit-tested as one. What those
 * tests cannot establish is that the world actually produces the inputs it is
 * given: that a refresh changes the artifact a step bound, that a re-run
 * rewrites its edges against what it read, and that the two together clear
 * exactly the causes the run answered and no others. So these drive the real
 * import, the real refresh and the real run lane.
 */

const seeded = vi.hoisted(() => ({ cleanupThrows: false }));

// The best-effort post-commit cleanup a staleness *mark* would have travelled
// with. There is no mark to lose in this design — the registry swap is itself
// the change record — and this suite is what proves that claim rather than
// asserting it.
vi.mock("@/lib/ingest/retire", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ingest/retire")>();
  return {
    ...actual,
    retireArtifact: (artifact: string) => {
      if (seeded.cleanupThrows) throw new Error("seeded cleanup failure");
      return actual.retireArtifact(artifact);
    },
  };
});

let dir: string;
let server: Server;
let base: string;
let recipeId: string;
/** Bumped to change what the fixture serves, so a refresh is a real change. */
let generation = 1;

const POINTS = () =>
  "label,lon,lat,value\n" +
  Array.from(
    { length: 2 + generation },
    (_, i) => `p${i},${13 + i / 100},${52 + i / 100},${i + generation}`,
  ).join("\n") +
  "\n";

/** Zones A–D, 10 wide, along the x axis — the join's left input. */
const ZONES = `name,wkt,pop
A,"POLYGON((0 0, 10 0, 10 10, 0 10, 0 0))",100
B,"POLYGON((10 0, 20 0, 20 10, 10 10, 10 0))",200
`;

beforeEach(async () => {
  resetLane();
  resetRefreshFences();
  generation = 1;
  seeded.cleanupThrows = false;
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  // The egress policy blocks loopback by default; this suite's fixture server
  // lives there, so it opts in the way an administrator would.
  process.env.DEZFIL_EGRESS_ALLOWLIST = "127.0.0.1";
  closeMetadataDb();
  resetQueryInstance();

  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/csv" });
    res.end(
      req.url?.includes("beta")
        ? `key,n\nx,${generation}\ny,${generation * 2}\n`
        : POINTS(),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await importFromUrl(testAccountScope(), `${base}/alpha.csv`, "alpha");
  await importFromUrl(testAccountScope(), `${base}/beta.csv`, "beta");
  const zones = path.join(dir, "zones.csv");
  await writeFile(zones, ZONES);
  await ingestFile(testAccountScope(), zones, "zones.csv");

  recipeId = createRecipe(testAccountScope(), "R").id;
});

afterEach(async () => {
  resetLane();
  closeMetadataDb();
  resetQueryInstance();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.DEZFIL_DATA_DIR;
  delete process.env.DEZFIL_EGRESS_ALLOWLIST;
  await rm(dir, { recursive: true, force: true });
});

const step = (sql: string, name: string) =>
  addStep(recipeId, { operation: "sql_step", parameters: { sql, name } });

async function run(stepId: string) {
  const job = await startStepRun(testAccountScope(), stepId);
  await laneSettled();
  return getJob(job.id)!;
}

/** Change what the source serves, then re-run its stored import. */
async function refresh(name: string) {
  generation += 1;
  await refreshTable(testAccountScope(), name);
}

const causes = async (stepId: string): Promise<StaleCause[]> =>
  (await readStep(recipeId, stepId)).condition.causes;

const reasons = async (stepId: string) =>
  (await causes(stepId)).map((c) => c.reason).sort();

describe("a refreshed source", () => {
  it("marks the step that read it, naming the input", async () => {
    const s = step("SELECT * FROM alpha", "from_alpha");
    await run(s.id);
    expect((await readStep(recipeId, s.id)).condition.primary).toBe("current");

    await refresh("alpha");

    const c = await causes(s.id);
    expect(c).toHaveLength(1);
    expect(c[0].reason).toBe("source_changed");
    expect(c[0].tableName).toBe("alpha");
    expect((await readStep(recipeId, s.id)).condition.primary).toBe("stale");
  }, 60_000);

  it("still marks it when the refresh's best-effort cleanup throws", async () => {
    const s = step("SELECT * FROM alpha", "from_alpha");
    await run(s.id);

    seeded.cleanupThrows = true;
    await refresh("alpha");

    // The **first** read after the refresh. A design that wrote a mark inside
    // that cleanup would report this step current here, and unlike a lost tile
    // invalidation there is no later path that repairs it.
    expect(await reasons(s.id)).toEqual(["source_changed"]);
  }, 60_000);

  it("does not mark a step that does not read it", async () => {
    const s = step("SELECT * FROM beta", "from_beta");
    await run(s.id);
    await refresh("alpha");
    expect(await causes(s.id)).toEqual([]);
    expect((await readStep(recipeId, s.id)).condition.primary).toBe("current");
  }, 60_000);
});

describe("through the graph", () => {
  it("carries staleness downstream, then records the re-run that answered it", async () => {
    const one = step("SELECT * FROM alpha", "g_one");
    await run(one.id);
    const two = step("SELECT count(*) AS n FROM g_one", "g_two");
    await run(two.id);

    await refresh("alpha");
    expect(await reasons(one.id)).toEqual(["source_changed"]);
    // Two's own input has not moved — its producer is what is out of date.
    expect(await reasons(two.id)).toEqual(["upstream_stale"]);

    await run(one.id);
    expect(await causes(one.id)).toEqual([]);
    // Now the artifact under two really did change.
    expect(await reasons(two.id)).toEqual(["upstream_re_ran"]);
    expect((await causes(two.id))[0].producedByStepId).toBe(one.id);
  }, 120_000);

  it("reports simultaneous causes, each naming its source", async () => {
    const one = step("SELECT * FROM alpha", "s_one");
    await run(one.id);
    const two = step(
      "SELECT (SELECT count(*) FROM s_one) AS a, (SELECT count(*) FROM beta) AS b",
      "s_two",
    );
    await run(two.id);

    // Two things at once: an input of two's was refreshed, and its producer
    // re-ran. Discarding either would leave the API unable to say why the
    // output is out of date.
    await refresh("beta");
    await refresh("alpha");
    await run(one.id);

    const c = await causes(two.id);
    expect(c.map((x) => x.reason).sort()).toEqual([
      "source_changed",
      "upstream_re_ran",
    ]);
    expect(
      Object.fromEntries(c.map((x) => [x.reason, x.tableName])),
    ).toEqual({ source_changed: "beta", upstream_re_ran: "s_one" });
  }, 150_000);

  it("clears what the run answered and nothing else", async () => {
    const one = step("SELECT * FROM alpha", "c_one");
    await run(one.id);
    const two = step(
      "SELECT (SELECT count(*) FROM c_one) AS a, (SELECT count(*) FROM beta) AS b",
      "c_two",
    );
    await run(two.id);

    await refresh("alpha");
    await refresh("beta");
    expect(await reasons(two.id)).toEqual(["source_changed", "upstream_stale"]);

    await run(two.id);

    // The refreshed source it just bound is answered; the producer that is
    // still stale is not, and running two could not have made it current.
    expect(await reasons(two.id)).toEqual(["upstream_stale"]);
    expect(await reasons(one.id)).toEqual(["source_changed"]);
  }, 150_000);
});

describe("a change arriving mid-run", () => {
  const SLOW =
    "SELECT (SELECT count(*) FROM alpha) AS k, a.range AS n " +
    "FROM range(40000) a, range(40000) b WHERE (a.range * b.range) % 7 = 3";

  it("is still active when the run that missed it finishes", async () => {
    const s = step(SLOW, "mid_run_out");
    const tables = path.join(dir, "data", "tables");
    const before = new Set(await readdir(tables));
    const job = await startStepRun(testAccountScope(), s.id);

    // Wait until it is genuinely working, then move the ground under it.
    const deadline = Date.now() + 60_000;
    while (!(await readdir(tables)).some((f) => !before.has(f))) {
      if (Date.now() > deadline) throw new Error("the run never began writing");
      await new Promise((r) => setTimeout(r, 25));
    }
    // Genuinely mid-run, not "after it happened to finish" — without this the
    // case degrades into the already-committed case and would pass on a design that only
    // marks work that had already committed.
    expect(getJob(job.id)!.state).toBe("running");
    await refresh("alpha");
    await laneSettled();

    expect(getJob(job.id)!.state).toBe("succeeded");
    // The run bound the older artifact and wrote that in its edge, so the
    // mismatch is there the moment it lands. A design comparing completion
    // times would call this current: the producer's refresh finished *before*
    // the consumer did.
    expect(await reasons(s.id)).toEqual(["source_changed"]);
  }, 180_000);
});

describe("a re-run replaces the edge set", () => {
  it("stops being marked by a table it no longer reads", async () => {
    const s = step("SELECT count(*) AS n FROM alpha", "moved_out");
    await run(s.id);

    editStep(s.id, { sql: "SELECT count(*) AS n FROM beta", name: "moved_out" });
    await run(s.id);

    await refresh("alpha");
    expect(await causes(s.id)).toEqual([]);

    await refresh("beta");
    expect((await causes(s.id)).map((c) => c.tableName)).toEqual(["beta"]);
  }, 120_000);
});

describe("the join's right input", () => {
  it("makes the join's output stale when it is refreshed", async () => {
    const s = addStep(recipeId, {
      operation: "spatial_join",
      parameters: {
        left: "zones",
        right: "alpha",
        predicate: "contains",
        carry: [{ aggregate: "count" }],
        name: "joined",
      },
    });
    await run(s.id);
    expect((await readStep(recipeId, s.id)).condition.primary).toBe("current");

    // The right input's geometry is not kept, and its rows are only ever read
    // inside a correlated subquery — neither is a reason for a refresh of it
    // to go unnoticed.
    await refresh("alpha");

    const c = await causes(s.id);
    expect(c.map((x) => x.tableName)).toEqual(["alpha"]);
    expect(c[0].reason).toBe("source_changed");
  }, 120_000);
});

describe("the whole recipe reads consistently", () => {
  it("reports every step against one registry snapshot", async () => {
    const one = step("SELECT * FROM alpha", "v_one");
    await run(one.id);
    const two = step("SELECT count(*) AS n FROM v_one", "v_two");
    await run(two.id);

    await refresh("alpha");
    const view = (await readRecipe(recipeId));
    expect(view.steps.map((s) => s.condition.primary)).toEqual(["stale", "stale"]);
    expect(view.steps[0].latestAttempt?.state).toBe("succeeded");
  }, 120_000);
});
