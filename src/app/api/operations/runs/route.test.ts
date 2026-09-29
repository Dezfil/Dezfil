import { testAccountScope, testAccountRequest } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { boundedEvaluation } from "@/lib/query/bounded";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import { getTableByName } from "@/lib/metadata/tables";
import { laneSettled, resetLane } from "@/lib/operations/lane";
import { POST as runOperation } from "../run/route";
import { GET as listRuns } from "./route";
import { GET as readRun } from "./[id]/route";
import { POST as cancelRunRoute } from "./[id]/cancel/route";

let dir: string;

beforeEach(async () => {
  resetLane();
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
  const src = path.join(dir, "stations.csv");
  await writeFile(src, "name,lon,lat\nalexanderplatz,13.41,52.52\nzoo,13.33,52.51\n");
  await ingestFile(testAccountScope(), src, "stations.csv");
  await boundedEvaluation(async () => undefined);
});

afterEach(async () => {
  resetLane();
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

function post(body: unknown, signal?: AbortSignal): Request {
  return new Request("http://test/api/operations/run", {
    method: "POST",
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

const step = (sql: string, name: string, subject?: string) => ({
  operation: "sql_step",
  parameters: { sql, name },
  ...(subject ? { subject } : {}),
});

describe("the run endpoint answers before the work is done", () => {
  it("accepts with 202, a non-terminal run, and nowhere yet to find the output", async () => {
    const response = await runOperation(testAccountRequest(post(step("SELECT name FROM stations", "accepted"))));
    expect(response.status).toBe(202);

    const { run } = (await response.json()) as { run: Record<string, unknown> };
    expect(run.id).toBeTruthy();
    expect(["queued", "running"]).toContain(run.state);
    expect(run.output).toBeUndefined();
    // The output genuinely does not exist at the instant the answer arrives.
    expect(getTableByName("accepted")).toBeNull();
    // And the caller is told where to watch it.
    expect(response.headers.get("Location")).toBe(`/api/operations/runs/${run.id}`);

    await laneSettled();
  }, 30_000);

  it("is later terminal, with its output registered and queryable", async () => {
    const accepted = await runOperation(testAccountRequest(post(step("SELECT name FROM stations", "eventual"))));
    const { run } = (await accepted.json()) as { run: { id: string } };
    await laneSettled();

    const read = await readRun(testAccountRequest(new Request("http://test")), {
      params: Promise.resolve({ id: run.id }),
    });
    expect(read.status).toBe(200);
    const body = (await read.json()) as { run: Record<string, unknown> };
    expect(body.run.state).toBe("succeeded");
    expect(body.run.output).toMatchObject({ name: "eventual" });
    expect(getTableByName("eventual")).not.toBeNull();
  }, 30_000);
});

describe("a malformed body is an admission refusal, not a server error", () => {
  const send = (raw: string) =>
    runOperation(
      testAccountRequest(new Request("http://test/api/operations/run", { method: "POST", body: raw })),
    );

  it("refuses invalid JSON with the documented code", async () => {
    const response = await send("{not json at all");
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    // Documented in the admission table as refused here — left unhandled it
    // throws out of parsing and answers an internal 500 instead.
    expect(body.error.code).toBe("invalid_request");
  });

  it("refuses a body that is not an object", async () => {
    for (const raw of ["null", "42", '"a string"', "[1,2]"]) {
      const response = await send(raw);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("invalid_request");
    }
  });
});

describe("the poll contract, proven on one seeded slow run (F3)", () => {
  // ~4 seconds of real engine work: long enough that a poll lands while the
  // run is genuinely mid-flight, short enough to finish inside the test.
  const SLOW =
    "SELECT count(*) AS n FROM range(40000) a, range(40000) b WHERE (a.range * b.range) % 7 = 3";

  async function pollRun(id: string) {
    const response = await readRun(testAccountRequest(new Request("http://test")), {
      params: Promise.resolve({ id }),
    });
    return ((await response.json()) as { run: Record<string, unknown> }).run;
  }

  it("is observed non-terminal, then terminal with its output registered", async () => {
    const accepted = await runOperation(testAccountRequest(post(step(SLOW, "slow_result"))));
    const { run } = (await accepted.json()) as { run: { id: string } };

    // The decisive part: a re-read of the durable record, not the acceptance
    // body. The 202's body is built at admission and always says queued, so
    // asserting against it would prove nothing about the run's real state.
    let sawNonTerminal = false;
    const deadline = Date.now() + 60_000;
    for (;;) {
      const polled = await pollRun(run.id);
      if (polled.state === "running" || polled.state === "queued") {
        sawNonTerminal = true;
        expect(polled.output).toBeUndefined();
      }
      if (["succeeded", "failed", "cancelled"].includes(polled.state as string)) break;
      if (Date.now() > deadline) throw new Error("the seeded run never settled");
      await new Promise((r) => setTimeout(r, 100));
    }

    // If the run were too fast to ever be caught mid-flight, this criterion
    // would not have been exercised — so failing here is correct.
    expect(sawNonTerminal).toBe(true);

    const settled = await pollRun(run.id);
    expect(settled.state).toBe("succeeded");
    expect(settled.output).toMatchObject({ name: "slow_result" });
    expect(getTableByName("slow_result")).not.toBeNull();

    await laneSettled();
  }, 120_000);
});

describe("an accepted run outlives its request", () => {
  it("succeeds even though the caller left immediately", async () => {
    const controller = new AbortController();
    const response = await runOperation(
      testAccountRequest(post(step("SELECT name FROM stations", "abandoned"), controller.signal)),
    );
    const { run } = (await response.json()) as { run: { id: string; state: string } };
    // Observed accepted and non-terminal, then abandoned — the order matters,
    // because aborting before acceptance would prove something else.
    expect(["queued", "running"]).toContain(run.state);
    controller.abort();

    await laneSettled();

    const read = await readRun(testAccountRequest(new Request("http://test")), {
      params: Promise.resolve({ id: run.id }),
    });
    const body = (await read.json()) as { run: Record<string, unknown> };
    expect(body.run.state).toBe("succeeded");
    expect(getTableByName("abandoned")).not.toBeNull();
  }, 30_000);
});

describe("the run resource", () => {
  it("answers not_found for an unknown id", async () => {
    const response = await readRun(testAccountRequest(new Request("http://test")), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("lists newest first and filters to one subject", async () => {
    await runOperation(testAccountRequest(post(step("SELECT 1 AS n", "one", "shared"))));
    await laneSettled();
    await runOperation(testAccountRequest(post(step("SELECT 2 AS n", "two", "shared"))));
    await laneSettled();
    await runOperation(testAccountRequest(post(step("SELECT 3 AS n", "three", "other"))));
    await laneSettled();

    const all = (await (await listRuns(testAccountRequest(new Request("http://test/api/operations/runs")))).json()) as {
      runs: { parameters: { name: string } }[];
    };
    expect(all.runs.map((r) => r.parameters.name)).toEqual(["three", "two", "one"]);

    const mine = (await (
      await listRuns(testAccountRequest(new Request("http://test/api/operations/runs?subject=shared")))
    ).json()) as { runs: { parameters: { name: string } }[] };
    expect(mine.runs.map((r) => r.parameters.name)).toEqual(["two", "one"]);
  }, 60_000);

  it("cancelling a finished run answers it unchanged, not an error", async () => {
    const accepted = await runOperation(testAccountRequest(post(step("SELECT 1 AS n", "already_done"))));
    const { run } = (await accepted.json()) as { run: { id: string } };
    await laneSettled();

    const response = await cancelRunRoute(testAccountRequest(new Request("http://test", { method: "POST" })), {
      params: Promise.resolve({ id: run.id }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { run: { state: string } };
    expect(body.run.state).toBe("succeeded");
  }, 30_000);

  it("cancelling an unknown run answers not_found", async () => {
    const response = await cancelRunRoute(testAccountRequest(new Request("http://test", { method: "POST" })), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(response.status).toBe(404);
  });
});

describe("a run reports timings and no percentage", () => {
  it("carries no percentage while queued, and no start time either", async () => {
    const response = await runOperation(testAccountRequest(post(step("SELECT 1 AS n", "timed"))));
    const { run } = (await response.json()) as { run: Record<string, unknown> };

    const keys = Object.keys(run).join(" ").toLowerCase();
    expect(keys).not.toContain("percent");
    expect(keys).not.toContain("progress");
    expect(run.acceptedAt).toBeTruthy();
    if (run.state === "queued") expect(run.startedAt).toBeUndefined();

    await laneSettled();
  }, 30_000);

  it("carries a start time once it has run, and still no percentage", async () => {
    const accepted = await runOperation(testAccountRequest(post(step("SELECT 1 AS n", "timed_done"))));
    const { run } = (await accepted.json()) as { run: { id: string } };
    await laneSettled();

    const body = (await (
      await readRun(testAccountRequest(new Request("http://test")), { params: Promise.resolve({ id: run.id }) })
    ).json()) as { run: Record<string, unknown> };

    expect(body.run.startedAt).toBeTruthy();
    expect(body.run.finishedAt).toBeTruthy();
    expect(Object.keys(body.run).join(" ").toLowerCase()).not.toContain("percent");
  }, 30_000);
});

describe("the published error catalogue", () => {
  /**
   * The codes approved at the gate, written here rather than derived from the
   * implementation. Comparing the union to the catalogue would only prove they
   * agree with each other; this is what makes the check non-tautological.
   */
  const APPROVED_AT_THE_GATE = [
    // gate.
    "operation_timeout",
    "operation_queue_full",
    "operation_interrupted",
    // The one code this adds, chosen over a sixth job state. The delta is
    // asserted separately.
    "operation_superseded",
  ] as const;

  it("documents exactly the codes the gate approved, and no others", () => {
    for (const code of APPROVED_AT_THE_GATE) {
      expect(ERROR_CATALOGUE).toHaveProperty(code);
      expect(ERROR_CATALOGUE[code].length).toBeGreaterThan(20);
    }
    const operationCodes = Object.keys(ERROR_CATALOGUE).filter((c) =>
      c.startsWith("operation_"),
    );
    expect(operationCodes.sort()).toEqual([...APPROVED_AT_THE_GATE].sort());
  });
});
