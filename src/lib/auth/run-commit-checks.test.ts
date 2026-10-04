import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DuckDBConnection } from "@duckdb/node-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { addStep, createRecipe, editStep } from "@/lib/metadata/recipes";
import { deleteProject, fileRecipe } from "@/lib/metadata/projects";
import { runnerOutput } from "@/lib/metadata/recipe-outputs";
import { getJob } from "@/lib/metadata/jobs";
import { cascadeSettled, readCascade, startCascade, startSingleRun } from "@/lib/operations/cascade";
import { isExecuting, laneSettled, resetLane } from "@/lib/operations/lane";
import { cancelRun, startRun } from "@/lib/operations/run";
import { removeTable } from "@/lib/table-service";
import { createApiToken } from "./credentials";
import { requireRequestAuth } from "./http";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { shareProject, unfileDataset } from "@/lib/test-support/sharing";
import type { CascadeRun } from "@/lib/metadata/cascades";
import type { AccountScope } from "./scope";

/**
 * What a run's commit checks, proven with a held step and a change applied
 * while it waits.
 *
 * Pat owns projects P and Q. Ada, an editor of both, owns workflow W filed in
 * P, reading her `roads` filed in P, and workflow V filed in Q, reading Bob's
 * own unfiled `mine` by its qualified name. Bob is an editor of P and Q.
 *
 * At each output's commit the runner's permission and reach to its inputs
 * are asked again. A runner who lost the right to run the workflow still
 * completes what was admitted, privately: into their own dataset, unfiled,
 * with the workflow's recorded outputs, proposals and definitions untouched,
 * and nothing further admitted. An input another person withdrew before the
 * commit refuses the output even though it was already read. A workflow
 * moved or transferred while running files into its project as it stands at
 * commit. The initiator keeps the right to cancel their own run by its
 * identifier after they stop reaching the workflow, without seeing it.
 */
const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
let scopes: Record<string, AccountScope>;
let roads: string;
let mine: string;
let W: string, S: string, T: string, V: string, VS: string;

const hold = vi.hoisted(() => ({ armed: false, reached: () => {}, released: Promise.resolve() }));

beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "run-commit-checks-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb(); resetQueryInstance(); resetLane();
  hold.armed = false;
  scopes = Object.fromEntries(["pat", "ada", "bob", "cyd"].map((id) => [id, testAccountScope(undefined, id)]));
  for (const [owner, name] of [["ada", "roads"], ["bob", "mine"]] as const) {
    const file = path.join(directory, `${owner}-${name}.csv`);
    await writeFile(file, `sentinel,lon,lat\n${owner} ${name},1,2\n`);
    const id = (await ingestFile(scopes[owner], file, `${name}.csv`)).id;
    if (name === "roads") roads = id; else mine = id;
  }
  shareProject("pat", "P", [["ada", "editor"], ["bob", "editor"]], [roads]);
  shareProject("pat", "Q", [["ada", "editor"], ["bob", "editor"]]);
  shareProject("pat", "R", [["ada", "editor"], ["bob", "editor"]]);
  W = createRecipe(scopes.ada, "Survey").id;
  fileRecipe(W, "P");
  S = addStep(W, { operation: "sql_step", parameters: { sql: "SELECT sentinel, 'held_marker' AS mark FROM roads", name: "staged" } }).id;
  T = addStep(W, { operation: "sql_step", parameters: { sql: "SELECT count(*) AS n FROM staged", name: "tally" } }).id;
  V = createRecipe(scopes.ada, "Copy").id;
  fileRecipe(V, "Q");
  VS = addStep(V, { operation: "sql_step", parameters: { sql: "SELECT sentinel, 'held_marker' AS mark FROM bob.mine", name: "copied" } }).id;
});
afterEach(async () => {
  hold.armed = false;
  vi.restoreAllMocks();
  await laneSettled(); resetLane(); closeMetadataDb(); resetQueryInstance(); vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

/** Arm a hold right after the step's statement has been read and written to
 * its artifact, before anything commits. A handshake, never a timing guess. */
function armHold() {
  let reached!: () => void;
  let release!: () => void;
  const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const run = DuckDBConnection.prototype.run;
  let used = false;
  vi.spyOn(DuckDBConnection.prototype, "run").mockImplementation(async function (this: DuckDBConnection, sql, ...args) {
    const match = !used && sql.startsWith("COPY (") && sql.includes("held_marker");
    if (match) used = true;
    const result = await run.call(this, sql, ...args);
    if (match) { reached(); await released; }
    return result;
  });
  return {
    release,
    async reached() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([reachedPromise, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("the hold was never reached")), 15_000);
        })]);
      } finally { clearTimeout(timer); }
    },
  };
}

const db = () => metadataDb();
type Row = { id: string; owner_id: string; file: string };
const owned = (owner: string, name: string) =>
  db().prepare("SELECT id, owner_id, file FROM data_tables WHERE name = ? AND owner_id = ?").get(name, owner) as Row | undefined;
const filedIn = (id: string) => (db().prepare("SELECT project_id FROM project_datasets WHERE table_id = ?").all(id) as { project_id: string }[]).map((r) => r.project_id);
const member = (run: CascadeRun, stepId: string) => run.members.find((m) => m.stepId === stepId)!;
const record = (stepId: string) => db().prepare("SELECT parameters, proposed_parameters, output_table_id FROM recipe_steps WHERE id = ?").get(stepId);
const runnerEdges = (stepId: string, runner: string) => db().prepare("SELECT input_table_id FROM lineage_edges WHERE step_id = ? AND runner_id = ?").all(stepId, runner);
const read = (id: string) => db().prepare("SELECT * FROM cascade_runs WHERE id = ?").get(id) as { outcome: string | null };

async function heldRun(start: () => Promise<CascadeRun>, change: () => void | Promise<void>) {
  const held = armHold();
  const run = await start();
  try {
    await held.reached();
    await change();
  } finally { held.release(); }
  await cascadeSettled(run.id); await laneSettled();
  return run;
}

async function depart(project: string, kind: "session" | "token") {
  const { POST } = await import("@/app/api/projects/[id]/leave/route");
  const request = testAccountRequest(new Request(`http://instance.test/api/projects/${project}/leave`, { method: "POST" }), undefined, "bob");
  if (kind === "token") {
    const token = createApiToken(requireRequestAuth(request), "Leave during work");
    request.headers.delete("cookie"); request.headers.set("authorization", `Bearer ${token.secret}`);
  }
  const response = await POST(request, { params: Promise.resolve({ id: project }) });
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ left: true });
}

describe("authority lost while a run is in flight", () => {
  it("completes a demoted editor's admitted step privately and admits nothing further", async () => {
    const first = await startCascade(scopes.ada, { expectedRevision: readEditRevision({ kind: "workflow", id: W })?.editRevision, recipeId: W });
    await cascadeSettled(first.id); await laneSettled();
    const adaStaged = owned("ada", "staged")!;
    expect(editStep(S, { sql: "SELECT sentinel, 'held_marker' AS mark, 2 AS v FROM roads", name: "staged" })).toBe("proposed");
    const before = record(S);

    const run = await heldRun(() => startCascade(scopes.bob, { expectedRevision: readEditRevision({ kind: "workflow", id: W })?.editRevision, recipeId: W }),
      () => { db().prepare("UPDATE project_people SET role = 'viewer' WHERE project_id = 'P' AND account_id = 'bob'").run(); });

    const after = readCascade(scopes.bob, run.id);
    expect(after.outcome).toBe("partly_completed");
    const private_ = owned("bob", "staged")!;
    expect(member(after, S)).toMatchObject({ state: "succeeded", output: { id: private_.id, name: "staged" } });
    expect(getJob(member(after, S).jobId!)).toMatchObject({ state: "succeeded", outputId: private_.id });
    // Into Bob's own dataset, filed nowhere.
    expect(filedIn(private_.id)).toEqual([]);
    // The shared workflow is as it was: no association, lineage or promotion.
    expect(runnerOutput(S, "bob")).toBeNull();
    expect(runnerEdges(S, "bob")).toEqual([]);
    expect(record(S)).toEqual(before);
    expect((record(S) as { output_table_id: string }).output_table_id).toBe(adaStaged.id);
    expect(owned("ada", "staged")).toEqual(adaStaged);
    // Nothing further was admitted.
    expect(member(after, T)).toMatchObject({ state: "failed", stoppedBy: "forbidden", jobId: null });
    expect(owned("bob", "tally")).toBeUndefined();
  }, 60_000);

  it.each([
    ["the workflow unfiled", () => { fileRecipe(V, null); }],
    ["the runner removed from the project", () => { db().prepare("DELETE FROM project_people WHERE project_id = 'Q' AND account_id = 'bob'").run(); }],
    ["self-departure through a session", () => depart("Q", "session")],
    ["self-departure through a token", () => depart("Q", "token")],
    ["the project dissolved", () => { deleteProject("Q"); }],
  ])("completes privately when %s leaves the runner without the workflow", async (_label, change) => {
    const run = await heldRun(() => startSingleRun(scopes.bob, V, VS, { expectedRevision: readEditRevision({ kind: "workflow", id: V })?.editRevision }), change);
    expect(read(run.id).outcome).toBe("completed");
    const output = owned("bob", "copied")!;
    expect(filedIn(output.id)).toEqual([]);
    expect(runnerOutput(VS, "bob")).toBeNull();
    expect(runnerEdges(VS, "bob")).toEqual([]);
    expect((record(VS) as { output_table_id: string | null }).output_table_id).toBeNull();
  }, 60_000);
});

describe("a workflow changed while it runs", () => {
  it("files into the project it was moved to", async () => {
    await heldRun(() => startSingleRun(scopes.bob, W, S, { expectedRevision: readEditRevision({ kind: "workflow", id: W })?.editRevision }), () => { fileRecipe(W, "R"); });
    const output = owned("bob", "staged")!;
    expect(filedIn(output.id)).toEqual(["R"]);
    expect(runnerOutput(S, "bob")).toMatchObject({ id: output.id });
    expect(runnerEdges(S, "bob")).toEqual([{ input_table_id: roads }]);
  }, 60_000);

  it("files into its project after a transfer, the run still its runner's", async () => {
    await heldRun(() => startSingleRun(scopes.bob, W, S, { expectedRevision: readEditRevision({ kind: "workflow", id: W })?.editRevision }), () => {
      db().prepare("INSERT INTO ownership_transfer_gate VALUES (1, 'workflow', ?, 'ada', 'pat')").run(W);
      db().prepare("UPDATE recipes SET owner_id = 'pat' WHERE id = ?").run(W);
      db().prepare("DELETE FROM ownership_transfer_gate").run();
    });
    const output = owned("bob", "staged")!;
    expect(filedIn(output.id)).toEqual(["P"]);
    expect(runnerOutput(S, "bob")).toMatchObject({ id: output.id });
  }, 60_000);
});

describe("an input withdrawn before the output commits", () => {
  it.each([
    ["unfiled by its owner", () => { unfileDataset("P", roads); }],
    ["deleted by its owner", () => removeTable(scopes.ada, "roads")],
    ["self-departure through a session", () => depart("P", "session")],
    ["self-departure through a token", () => depart("P", "token")],
    ["out of reach once the runner leaves the project", () => { db().prepare("DELETE FROM project_people WHERE project_id = 'P' AND account_id = 'bob'").run(); }],
  ])("refuses the output when %s, though the step already read it", async (_label, change) => {
    const run = await heldRun(() => startSingleRun(scopes.bob, W, S, { expectedRevision: readEditRevision({ kind: "workflow", id: W })?.editRevision }), change);
    const job = getJob(member(readCascade(scopes.ada, run.id), S).jobId!)!;
    expect(job).toMatchObject({ state: "failed", errorCode: "sql_error", errorMessage: 'The dataset "roads" is not available to you.' });
    expect(owned("bob", "staged")).toBeUndefined();
    expect(runnerOutput(S, "bob")).toBeNull();
    expect(read(run.id).outcome).toBe("failed");
  }, 60_000);

  it("refuses a standalone run's output the same way", async () => {
    const held = armHold();
    const job = await startRun(scopes.bob, { operation: "sql_step", parameters: { sql: "SELECT sentinel, 'held_marker' AS mark FROM ada.roads", name: "solo" } });
    try { await held.reached(); unfileDataset("P", roads); } finally { held.release(); }
    await laneSettled();
    expect(getJob(job.id)).toMatchObject({ state: "failed", errorCode: "sql_error", errorMessage: 'The dataset "ada.roads" is not available to you.' });
    expect(owned("bob", "solo")).toBeUndefined();
  }, 60_000);

  it("keeps publishing when the runner deletes an input of their own", async () => {
    const run = await heldRun(() => startSingleRun(scopes.bob, V, VS, { expectedRevision: readEditRevision({ kind: "workflow", id: V })?.editRevision }), () => removeTable(scopes.bob, "mine"));
    expect(read(run.id).outcome).toBe("completed");
    const output = owned("bob", "copied")!;
    expect(filedIn(output.id)).toEqual(["Q"]);
    expect(runnerEdges(VS, "bob")).toEqual([{ input_table_id: mine }]);
  }, 60_000);
});

describe("cancelling a run after its initiator stops reaching the workflow", () => {
  it("is still the initiator's, by the run's identifier, answered without the run", async () => {
    db().prepare("UPDATE recipe_steps SET parameters = json_set(parameters, '$.sql', ?) WHERE id = ?")
      .run("SELECT count(*) AS n FROM range(200000) a, range(200000) b, bob.mine WHERE (a.range * b.range) % 7 = 3", VS);
    const run = await startSingleRun(scopes.bob, V, VS, { expectedRevision: readEditRevision({ kind: "workflow", id: V })?.editRevision });
    const jobId = member(run, VS).jobId!;
    try {
    db().prepare("DELETE FROM project_people WHERE project_id = 'Q' AND account_id = 'bob'").run();
    const call = async (account: string, recipe: string, method: "POST" | "GET") => {
      const load = method === "POST" ? await import("@/app/api/recipes/[id]/runs/[runId]/cancel/route") : await import("@/app/api/recipes/[id]/runs/[runId]/route");
      const handler = (load as unknown as Record<string, (r: Request, c: { params: Promise<{ id: string; runId: string }> }) => Promise<Response>>)[method];
      return handler(testAccountRequest(new Request(`http://instance.test/api/recipes/${recipe}/runs/${run.id}${method === "POST" ? "/cancel" : ""}`,
        { method, headers: { "content-type": "application/json" } }), undefined, account), { params: Promise.resolve({ id: recipe, runId: run.id }) });
    };
    // Bob does not see the run, and nobody else may cancel it by its identifier.
    expect((await call("bob", V, "GET")).status).toBe(404);
    expect((await call("cyd", V, "POST")).status).toBe(404);
    expect((await call("bob", W, "POST")).status).toBe(404);
    expect(read(run.id).outcome).toBeNull();
    const started = Date.now();
    const answer = await call("bob", V, "POST");
    expect(answer.status).toBe(204);
    expect(await answer.text()).toBe("");
    expect(Date.now() - started).toBeLessThan(15_000);
    await cascadeSettled(run.id);
    expect(read(run.id).outcome).toBe("cancelled");
    expect(getJob(jobId)?.state ?? "cancelled").toBe("cancelled");
    expect(isExecuting(jobId)).toBe(false);
    expect((await call("bob", V, "GET")).status).toBe(404);
    // The workflow's owner still cancels, and still sees the run.
    const owner = await call("ada", V, "POST");
    expect(owner.status).toBe(200);
    expect(await owner.json()).toMatchObject({ run: { id: run.id, outcome: "cancelled" } });
    } finally {
      if (getJob(jobId)?.state === "running") await cancelRun(scopes.bob, jobId);
    }
  }, 60_000);
});
