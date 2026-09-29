import { testAccountScope, testAccountRequest } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { boundedEvaluation } from "@/lib/query/bounded";
import { laneSettled, resetLane } from "@/lib/operations/lane";
import { POST as createRecipeRoute } from "./route";
import { POST as addStep } from "./[id]/steps/route";
import { GET as readRecipe } from "./[id]/route";
import { PATCH as editStep } from "./[id]/steps/[stepId]/route";
import { POST as runStep } from "./[id]/steps/[stepId]/run/route";
import { DELETE as discard } from "./[id]/steps/[stepId]/proposal/route";
import { DELETE as removeStep } from "./[id]/steps/[stepId]/route";
import { DELETE as deleteTable } from "./../tables/[name]/route";

/**
 * The editing contract: the name rule at add and edit, proposals and
 * their discard, the reorder inside an edit, removal truth. Driven
 * through the handlers, as the recipe surface's own tests are.
 */

let dir: string;

beforeEach(async () => {
  resetLane();
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
  const src = path.join(dir, "stations.csv");
  await writeFile(src, "name,lon,lat\nalex,13.41,52.52\nzoo,13.33,52.51\n");
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

type Json = Record<string, unknown>;
const body = async (r: Response) => (await r.json()) as Json;
const post = (payload: unknown) =>
  new Request("http://test/api/recipes", { method: "POST", body: JSON.stringify(payload) });
const P = (id: string) => ({ params: Promise.resolve({ id }) });
const PS = (id: string, stepId: string) => ({ params: Promise.resolve({ id, stepId }) });

async function newRecipe(name = "R"): Promise<string> {
  const r = await createRecipeRoute(testAccountRequest(post({ name })));
  expect(r.status).toBe(201);
  return ((await body(r)).recipe as Json).id as string;
}
const sqlStep = (sql: string, name: unknown) => ({ operation: "sql_step", parameters: name === undefined ? { sql } : { sql, name } });
async function add(id: string, sql: string, name: unknown) {
  return addStep(testAccountRequest(post(sqlStep(sql, name))), P(id));
}
async function stepsOf(id: string): Promise<Json[]> {
  return ((await body(await readRecipe(testAccountRequest(post({})), P(id)))).recipe as Json).steps as Json[];
}
async function refused(response: Response, code: string, pattern: RegExp) {
  expect(response.status).toBe(400);
  const error = (await body(response)).error as Json;
  expect(error.code).toBe(code);
  expect(error.message).toMatch(pattern);
}

describe("the name rule at add and edit", () => {
  it("stores an accepted name in its registered form, and refuses a blank or letterless one in its own words", async () => {
    const id = await newRecipe();
    const added = await add(id, "SELECT name FROM stations", "  Chain One ");
    expect(added.status).toBe(201);
    expect((((await body(added)).step as Json).parameters as Json).name).toBe("chain_one");
    await refused(await add(id, "SELECT 1 AS n", ""), "invalid_request", /needs a name/);
    await refused(await add(id, "SELECT 1 AS n", "   "), "invalid_request", /needs a name/);
    await refused(await add(id, "SELECT 1 AS n", "!!! ???"), "invalid_request", /no letters or digits/);
    // A node may be added before it is named; the run refuses a nameless one.
    expect((await add(id, "SELECT 1 AS n", undefined)).status).toBe(201);
  });

  it("refuses a table's name, also when it collides only after normalization, naming the table", async () => {
    const id = await newRecipe();
    await refused(await add(id, "SELECT 1 AS n", "stations"), "name_taken", /"stations" already exists/);
    await refused(await add(id, "SELECT 1 AS n", "Stations"), "name_taken", /"stations" already exists/);
    await refused(await add(id, "SELECT 1 AS n", " STATIONS "), "name_taken", /"stations" already exists/);
  });

  it("refuses a sibling node's declared name, naming the sibling, at add and at edit; another workflow's declaration is no reservation", async () => {
    const id = await newRecipe();
    expect((await add(id, "SELECT name FROM stations", "first_out")).status).toBe(201);
    await refused(await add(id, "SELECT 1 AS n", "First Out"), "name_taken", /Another node of this workflow \(SQL step\) already declares "first_out"/);
    const second = await add(id, "SELECT 1 AS n", "second_out");
    expect(second.status).toBe(201);
    const secondId = ((await body(second)).step as Json).id as string;
    await refused(
      await editStep(testAccountRequest(post({ parameters: { sql: "SELECT 1 AS n", name: "first_out" } })), PS(id, secondId)),
      "name_taken",
      /already declares "first_out"/,
    );
    // Its own name again is not a conflict, and a free one is stored registered.
    expect((await editStep(testAccountRequest(post({ parameters: { sql: "SELECT 2 AS n", name: "second_out" } })), PS(id, secondId))).status).toBe(200);
    const renamed = await editStep(testAccountRequest(post({ parameters: { sql: "SELECT 2 AS n", name: "Second Out Two" } })), PS(id, secondId));
    expect(renamed.status).toBe(200);
    expect((((await body(renamed)).step as Json).parameters as Json).name).toBe("second_out_two");
    // Another workflow may declare first_out too: no reservation across workflows.
    const other = await newRecipe("Other");
    expect((await add(other, "SELECT name FROM stations", "first_out")).status).toBe(201);
  });

  it("freezes a produced output's name while allowing other edits to the same node", async () => {
    const id = await newRecipe();
    const added = await add(id, "SELECT name FROM stations", "frozen_out");
    const stepId = ((await body(added)).step as Json).id as string;
    expect((await runStep(testAccountRequest(post({})), PS(id, stepId))).status).toBe(202);
    await laneSettled();
    expect(((await stepsOf(id))[0].output as Json).name).toBe("frozen_out");
    await refused(
      await editStep(testAccountRequest(post({ parameters: { sql: "SELECT name FROM stations", name: "frozen_out_2" } })), PS(id, stepId)),
      "invalid_request",
      /"frozen_out" keeps its name after its first run/,
    );
    // A definition that leaves the name out is a change to it: refused the same way.
    await refused(
      await editStep(testAccountRequest(post({ parameters: { sql: "SELECT name FROM stations" } })), PS(id, stepId)),
      "invalid_request",
      /"frozen_out" keeps its name after its first run/,
    );
    const other = await editStep(testAccountRequest(post({ parameters: { sql: "SELECT name, lon FROM stations", name: "frozen_out" } })), PS(id, stepId));
    expect(other.status).toBe(200);
    expect((await body(other)).applied).toBe("proposed");
  }, 90_000);

});

describe("proposals and their discard", () => {
  it("clears a pending edit when an edit puts the active definition back, and discards one in one call", async () => {
    const id = await newRecipe();
    const added = await add(id, "SELECT name FROM stations", "prop_out");
    const stepId = ((await body(added)).step as Json).id as string;
    expect((await runStep(testAccountRequest(post({})), PS(id, stepId))).status).toBe(202);
    await laneSettled();
    // A change after the run is a proposal.
    const changed = await editStep(testAccountRequest(post({ parameters: { sql: "SELECT name, lon FROM stations", name: "prop_out" } })), PS(id, stepId));
    expect((await body(changed)).applied).toBe("proposed");
    expect((await stepsOf(id))[0].proposedParameters).not.toBeNull();
    // Putting the active values back, keys in another order, clears it.
    const restored = await editStep(testAccountRequest(post({ parameters: { name: "prop_out", sql: "SELECT name FROM stations" } })), PS(id, stepId));
    expect((await body(restored)).applied).toBe("active");
    expect((await stepsOf(id))[0].proposedParameters).toBeNull();
    // Discard clears a fresh proposal in one call; without one it changes nothing and says so.
    await editStep(testAccountRequest(post({ parameters: { sql: "SELECT name, lat FROM stations", name: "prop_out" } })), PS(id, stepId));
    const dropped = await discard(testAccountRequest(post({})), PS(id, stepId));
    expect(dropped.status).toBe(200);
    expect((await body(dropped)).discarded).toBe(true);
    const steps = await stepsOf(id);
    expect(steps[0].proposedParameters).toBeNull();
    expect((steps[0].parameters as Json).sql).toBe("SELECT name FROM stations");
    const nothing = await discard(testAccountRequest(post({})), PS(id, stepId));
    expect((await body(nothing)).discarded).toBe(false);
    expect((await discard(testAccountRequest(post({})), PS(id, "nope"))).status).toBe(404);
  }, 90_000);

});

describe("the order inside an edit, and SQL that does not parse", () => {
  const order = async (id: string) => (await stepsOf(id)).map((s) => (s.parameters as Json).name);

  it("moves the reader and its dependents after a later producer, keeps unrelated steps in place, and refuses whole when the order cannot be valid", async () => {
    const id = await newRecipe();
    // a (reader), b (reads a), c (unrelated), d (the later producer)
    const a = ((await body(await add(id, "SELECT name FROM stations", "ord_a"))).step as Json).id as string;
    await add(id, "SELECT * FROM ord_a", "ord_b");
    await add(id, "SELECT 1 AS n", "ord_c");
    await add(id, "SELECT lon FROM stations", "ord_d");
    expect(await order(id)).toEqual(["ord_a", "ord_b", "ord_c", "ord_d"]);
    // a now reads d: a and b move after d; c keeps its place before d.
    const linked = await editStep(testAccountRequest(post({ parameters: { sql: "SELECT * FROM ord_d", name: "ord_a" } })), PS(id, a));
    expect(linked.status).toBe(200);
    expect(await order(id)).toEqual(["ord_c", "ord_d", "ord_a", "ord_b"]);
    // d cannot come to read b: b depends on a, which now depends on d — a cycle;
    // the input and the order are both as they were.
    const d = (await stepsOf(id)).find((s) => (s.parameters as Json).name === "ord_d")!.id as string;
    const cyclic = await editStep(testAccountRequest(post({ parameters: { sql: "SELECT * FROM ord_b", name: "ord_d" } })), PS(id, d));
    expect(cyclic.status).toBe(400);
    expect(await order(id)).toEqual(["ord_c", "ord_d", "ord_a", "ord_b"]);
    expect(((await stepsOf(id)).find((s) => s.id === d)!.parameters as Json).sql).toBe("SELECT lon FROM stations");
    // A self-read is still refused.
    expect((await editStep(testAccountRequest(post({ parameters: { sql: "SELECT * FROM ord_d", name: "ord_d" } })), PS(id, d))).status).toBe(400);
  });

  it("keeps the other steps' reads for the reorder when a sibling's SQL cannot be read", async () => {
    const id = await newRecipe();
    // a (reader), b (reads a), bad (unparseable), d (the later producer)
    const a = ((await body(await add(id, "SELECT name FROM stations", "tol_a"))).step as Json).id as string;
    await add(id, "SELECT * FROM tol_a", "tol_b");
    await add(id, "SELEC nonsense FROM", "tol_bad");
    await add(id, "SELECT lon FROM stations", "tol_d");
    expect(await order(id)).toEqual(["tol_a", "tol_b", "tol_bad", "tol_d"]);
    // a now reads d: b, which reads a, must move with it — the malformed
    // sibling must not have erased b's read of a.
    const linked = await editStep(testAccountRequest(post({ parameters: { sql: "SELECT * FROM tol_d", name: "tol_a" } })), PS(id, a));
    expect(linked.status).toBe(200);
    expect(await order(id)).toEqual(["tol_bad", "tol_d", "tol_a", "tol_b"]);
  });

  it("accepts SQL the parser cannot read, with empty present reads, at add and at edit", async () => {
    const id = await newRecipe();
    const added = await add(id, "SELEC nonsense FROM", "bad_sql");
    expect(added.status).toBe(201);
    let steps = await stepsOf(id);
    expect(steps[0].reads).toEqual([]);
    expect((steps[0].parameters as Json).sql).toBe("SELEC nonsense FROM");
    const stepId = steps[0].id as string;
    const edited = await editStep(testAccountRequest(post({ parameters: { sql: "SELECT name FROM stations WHERE", name: "bad_sql" } })), PS(id, stepId));
    expect(edited.status).toBe(200);
    steps = await stepsOf(id);
    expect(steps[0].reads).toEqual([]);
    // Once it parses, the reads are back.
    await editStep(testAccountRequest(post({ parameters: { sql: "SELECT name FROM stations", name: "bad_sql" } })), PS(id, stepId));
    expect((await stepsOf(id))[0].reads).toEqual(["stations"]);
  });

});

describe("removal truth", () => {
  const remove = (id: string, stepId: string) => removeStep(testAccountRequest(post({})), PS(id, stepId));

  it("says whether the dataset exists, was deleted, or never was, and who reads its name", async () => {
    const id = await newRecipe();
    // A produced node with one reader.
    const a = ((await body(await add(id, "SELECT name FROM stations", "rm_a"))).step as Json).id as string;
    await add(id, "SELECT * FROM rm_a", "rm_b");
    expect((await runStep(testAccountRequest(post({})), PS(id, a))).status).toBe(202);
    await laneSettled();
    const gone = await body(await remove(id, a));
    expect(gone.output).toEqual({ name: "rm_a", state: "exists" });
    expect(gone.outputsRemain).toBe(true);
    expect((gone.readers as Json[]).map((r) => r.label)).toEqual(["SQL step"]);
    expect(gone.message).toMatch(/remains.*One node reads it as a workspace table now/);
    // A produced node whose dataset was deleted since.
    const c = ((await body(await add(id, "SELECT name FROM stations", "rm_c"))).step as Json).id as string;
    expect((await runStep(testAccountRequest(post({})), PS(id, c))).status).toBe(202);
    await laneSettled();
    expect((await deleteTable(testAccountRequest(post({})), { params: Promise.resolve({ name: "rm_c" }) })).status).toBeLessThan(300);
    const deleted = await body(await remove(id, c));
    expect(deleted.output).toEqual({ name: "rm_c", state: "deleted" });
    expect(deleted.outputsRemain).toBe(false);
    expect(deleted.message).toMatch(/had already been deleted/);
    // A never-run node whose declared output a sibling reads.
    const d = ((await body(await add(id, "SELECT 1 AS n", "rm_d"))).step as Json).id as string;
    await add(id, "SELECT * FROM rm_d", "rm_e");
    const never = await body(await remove(id, d));
    expect(never.output).toEqual({ name: "rm_d", state: "never" });
    expect(never.outputsRemain).toBe(false);
    expect((never.readers as Json[]).length).toBe(1);
    expect(never.message).toMatch(/had not produced a dataset.*One node reads "rm_d", which nothing produces now/);
  }, 120_000);
});
