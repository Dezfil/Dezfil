import { withFixtureRevision } from "@/lib/test-support/edit-basis";
import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { testAccountScope, testAccountRequest } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { boundedEvaluation } from "@/lib/query/bounded";
import { createMap } from "@/lib/map-service";
import { insertLayer, type Layer } from "@/lib/metadata/maps";
import { getTableByName } from "@/lib/metadata/tables";
import { changeMembers, createProject, tableProjectIds } from "@/lib/metadata/projects";
import { laneSettled, resetLane } from "@/lib/operations/lane";
import { cascadeSettled } from "@/lib/operations/cascade";
import { listJobs } from "@/lib/metadata/jobs";
import { GET as listRecipes, POST as createRecipeRoute } from "./route";
import {
  DELETE as deleteRecipeRoute,
  GET as readRecipe,
  PATCH as renameRecipe,
} from "./[id]/route";
import { POST as addStep } from "./[id]/steps/route";
import {
  DELETE as removeStep,
  GET as readStep,
  PATCH as editStep,
} from "./[id]/steps/[stepId]/route";
import { POST as moveStep } from "./[id]/steps/[stepId]/move/route";
import { POST as duplicateRecipeRoute } from "./[id]/duplicate/route";
import { POST as runStep } from "./[id]/steps/[stepId]/run/route";
import { GET as listRuns, POST as runRecipe } from "./[id]/runs/route";
import { GET as readRun } from "./[id]/runs/[runId]/route";

/**
 * The recipe surface, driven through its own handlers.
 *
 * These exist because the unit tests below them can all be green while the
 * thing a caller actually reaches is not: the ordering rule enforced at the
 * repository is not the ordering rule enforced at the edit, and a capability
 * the contract promises is only promised if a route answers it.
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
  await boundedEvaluation(async () => undefined, { scope: testAccountScope() });
});

afterEach(async () => {
  resetLane();
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

const post = (body: unknown) =>
  new Request("http://test/api/recipes", {
    method: "POST",
    body: JSON.stringify(body),
  });

type Json = Record<string, unknown>;
const body = async (r: Response) => (await r.json()) as Json;

async function newRecipe(name = "R"): Promise<string> {
  const response = await createRecipeRoute(testAccountRequest(post({ name })));
  expect(response.status).toBe(201);
  return ((await body(response)).recipe as Json).id as string;
}

async function newStep(
  recipeId: string,
  sql: string,
  name: string,
): Promise<Json> {
  const response = await addStep(
    withFixtureRevision(testAccountRequest(post({ operation: "sql_step", parameters: { sql, name } })), readEditRevision({ kind: "workflow", id: recipeId })?.editRevision),
    { params: Promise.resolve({ id: recipeId }) },
  );
  expect(response.status).toBe(201);
  return (await body(response)).step as Json;
}

describe("a recipe round-trips", () => {
  it("keeps one name rule for create and rename: trimmed, non-empty, 120 at most, duplicates allowed", async () => {
    // Trimmed on the way in; the stored name is what the page shows.
    const created = await createRecipeRoute(testAccountRequest(post({ name: "  Cafés within reach  " })));
    expect(created.status).toBe(201);
    const id = ((await body(created)).recipe as Json).id as string;
    const read = (await body(
      await readRecipe(testAccountRequest(post({})), { params: Promise.resolve({ id }) }),
    )).recipe as Json;
    expect(read.name).toBe("Cafés within reach");
    // Blank and whitespace-only are refused at create and at rename alike.
    expect((await createRecipeRoute(testAccountRequest(post({ name: "" })))).status).toBe(400);
    expect((await createRecipeRoute(testAccountRequest(post({ name: "   " })))).status).toBe(400);
    expect(
      (await renameRecipe(withFixtureRevision(testAccountRequest(post({ name: " " })), readEditRevision({ kind: "workflow", id: id })?.editRevision), { params: Promise.resolve({ id }) })).status,
    ).toBe(400);
    // One past the limit is refused; the limit itself passes.
    const long = "x".repeat(121);
    expect((await createRecipeRoute(testAccountRequest(post({ name: long })))).status).toBe(400);
    expect(
      (await renameRecipe(withFixtureRevision(testAccountRequest(post({ name: long })), readEditRevision({ kind: "workflow", id: id })?.editRevision), { params: Promise.resolve({ id }) })).status,
    ).toBe(400);
    expect(
      (await renameRecipe(withFixtureRevision(testAccountRequest(post({ name: "y".repeat(120) })), readEditRevision({ kind: "workflow", id: id })?.editRevision), { params: Promise.resolve({ id }) })).status,
    ).toBe(200);
    // A name another recipe already has is fine, as it is for maps.
    const twin = await createRecipeRoute(testAccountRequest(post({ name: "y".repeat(120) })));
    expect(twin.status).toBe(201);
  });

  it("carries the surface that made it: a workflow unless told, the builder when told, nothing else", async () => {
    const plain = (await body(await createRecipeRoute(testAccountRequest(post({ name: "plain" }))))).recipe as Json;
    expect(plain.origin).toBe("workflow");
    const built = (await body(
      await createRecipeRoute(testAccountRequest(post({ name: "Analysis of stations", origin: "builder" }))),
    )).recipe as Json;
    expect(built.origin).toBe("builder");
    expect((await createRecipeRoute(testAccountRequest(post({ name: "x", origin: "canvas" })))).status).toBe(400);
    // Listed with it, and a rename leaves it alone.
    const renamed = (await body(
      await renameRecipe(withFixtureRevision(testAccountRequest(post({ name: "Still the builder's" })), readEditRevision({ kind: "workflow", id: built.id as string })?.editRevision), {
        params: Promise.resolve({ id: built.id as string }),
      }),
    )).recipe as Json;
    expect(renamed.origin).toBe("builder");
    const listed = (await body(await listRecipes(testAccountRequest(new Request("http://test/api/recipes"))))).recipes as Json[];
    expect(listed.find((r) => r.id === built.id)?.origin).toBe("builder");
    expect(listed.find((r) => r.id === plain.id)?.origin).toBe("workflow");
  });

  it("refuses a builder-origin recipe created into a project without leaving the recipe, while a workflow-origin recipe files", async () => {
    const project = createProject(testAccountScope(), { name: "Workflow shelf" });
    const refused = await createRecipeRoute(
      testAccountRequest(post({
        name: "Builder tool in a project",
        origin: "builder",
        projectId: project.id,
      })),
    );
    expect(refused.status).toBe(400);
    const refusal = (await refused.json()) as {
      error: { code: string; message: string };
    };
    expect(refusal.error.code).toBe("invalid_request");
    expect(refusal.error.message).toContain(
      "Only workflows can be project members.",
    );
    const afterRefusal = (await body(
      await listRecipes(testAccountRequest(new Request("http://test/api/recipes"))),
    )).recipes as Json[];
    expect(
      afterRefusal.some((recipe) => recipe.name === "Builder tool in a project"),
    ).toBe(false);

    const accepted = await createRecipeRoute(
      testAccountRequest(post({
        name: "Workflow in a project",
        origin: "workflow",
        projectId: project.id,
      })),
    );
    expect(accepted.status).toBe(201);
    expect(((await body(accepted)).recipe as Json).projectId).toBe(project.id);
  });

  it("a refused node leaves the last-edited time alone; an accepted one advances it", async () => {
    const id = await newRecipe("Edits");
    const at = async () =>
      ((await body(await readRecipe(testAccountRequest(post({})), { params: Promise.resolve({ id }) }))).recipe as Json)
        .updatedAt as string;
    const before = await at();
    // Reads its own output: refused at the change, and a refusal is not an edit.
    const refused = await addStep(
      withFixtureRevision(testAccountRequest(post({ operation: "sql_step", parameters: { sql: "SELECT * FROM self_out", name: "self_out" } })), readEditRevision({ kind: "workflow", id: id })?.editRevision),
      { params: Promise.resolve({ id }) },
    );
    expect(refused.status).toBe(400);
    expect(await at()).toBe(before);
    await newStep(id, "SELECT 1 AS n", "edit_one");
    expect((await at()) > before).toBe(true);
  });

  it("lists by origin on request, and answers a summary with every recipe", async () => {
    const w = (await body(await createRecipeRoute(testAccountRequest(post({ name: "a workflow" }))))).recipe as Json;
    const b = (await body(
      await createRecipeRoute(testAccountRequest(post({ name: "Analysis of stations", origin: "builder" }))),
    )).recipe as Json;
    await newStep(w.id as string, "SELECT name FROM stations", "sum_one");
    const list = async (query: string) =>
      (await body(await listRecipes(testAccountRequest(new Request("http://test/api/recipes" + query))))).recipes as Json[];
    const ids = (rs: Json[]) => rs.map((r) => r.id);
    expect(ids(await list(""))).toEqual(expect.arrayContaining([w.id, b.id]));
    expect(ids(await list("?origin=workflow"))).toEqual([w.id]);
    expect(ids(await list("?origin=builder"))).toEqual([b.id]);
    expect((await listRecipes(testAccountRequest(new Request("http://test/api/recipes?origin=canvas")))).status).toBe(400);
    const summaries = new Map((await list("")).map((r) => [r.id, r.summary as Json]));
    expect(summaries.get(w.id as string)).toEqual({
      nodes: 1, sources: 1, liveOutputs: 0, status: "never_run", count: 1,
    });
    expect(summaries.get(b.id as string)).toEqual({
      nodes: 0, sources: 0, liveOutputs: 0, status: "empty", count: 0,
    });
  });

  it("is created, named, listed, read back in order, and deleted", async () => {
    const id = await newRecipe("Accidents near schools");
    const one = await newStep(id, "SELECT 1 AS n", "rt_one");
    const two = await newStep(id, "SELECT 2 AS n", "rt_two");

    const listed = (await body(await listRecipes(testAccountRequest(new Request("http://test/api/recipes"))))).recipes as Json[];
    expect(listed.map((r) => r.id)).toContain(id);

    const read = (await body(
      await readRecipe(testAccountRequest(post({})), { params: Promise.resolve({ id }) }),
    )).recipe as Json;
    expect(read.name).toBe("Accidents near schools");
    expect((read.steps as Json[]).map((s) => s.id)).toEqual([one.id, two.id]);
    // A step that has never produced anything says so.
    expect((read.steps as Json[])[0].condition).toBe("never_run");

    const renamed = (await body(
      await renameRecipe(withFixtureRevision(testAccountRequest(post({ name: "Renamed" })), readEditRevision({ kind: "workflow", id: id })?.editRevision), {
        params: Promise.resolve({ id }),
      }),
    )).recipe as Json;
    expect(renamed.name).toBe("Renamed");

    const deleted = await body(
      await deleteRecipeRoute(withFixtureRevision(testAccountRequest(post({})), readEditRevision({ kind: "workflow", id: id })?.editRevision), { params: Promise.resolve({ id }) }),
    );
    expect(deleted.outputsRemain).toBe(true);
    expect(deleted.message).toMatch(/remain in the workspace/i);

    const gone = await readRecipe(testAccountRequest(post({})), { params: Promise.resolve({ id }) });
    expect(gone.status).toBe(404);
  }, 60_000);

  it("reorders a step, and a later read reports the new order", async () => {
    const id = await newRecipe();
    const one = await newStep(id, "SELECT 1 AS n", "ord_one");
    const two = await newStep(id, "SELECT 2 AS n", "ord_two");
    const three = await newStep(id, "SELECT 3 AS n", "ord_three");

    const moved = (await body(
      await moveStep(withFixtureRevision(testAccountRequest(post({ ordinal: 0 })), readEditRevision({ kind: "workflow", id: id })?.editRevision), {
        params: Promise.resolve({ id, stepId: three.id as string }),
      }),
    )).recipe as Json;
    expect((moved.steps as Json[]).map((s) => s.id)).toEqual([
      three.id,
      one.id,
      two.id,
    ]);

    const reread = (await body(
      await readRecipe(testAccountRequest(post({})), { params: Promise.resolve({ id }) }),
    )).recipe as Json;
    expect((reread.steps as Json[]).map((s) => s.ordinal)).toEqual([0, 1, 2]);
  }, 60_000);
});

describe("the backward-only rule is refused at the change", () => {
  it("refuses a step that would read its own output", async () => {
    const id = await newRecipe();
    const response = await addStep(
      withFixtureRevision(testAccountRequest(post({
        operation: "sql_step",
        parameters: { sql: "SELECT * FROM self_out", name: "self_out" },
      })), readEditRevision({ kind: "workflow", id: id })?.editRevision),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(400);
    expect(((await body(response)).error as Json).code).toBe("invalid_request");
    // Refused means not added.
    const read = (await body(
      await readRecipe(testAccountRequest(post({})), { params: Promise.resolve({ id }) }),
    )).recipe as Json;
    expect(read.steps).toHaveLength(0);
  }, 60_000);

  it("orders, rather than refuses, an edit that would read a later step's output", async () => {
    const id = await newRecipe();
    const first = await newStep(id, "SELECT 1 AS n", "back_one");
    await newStep(id, "SELECT 2 AS n", "back_two");

    // The rule stands — a step reads earlier steps only — and the edit is
    // what moves: the reader goes after its producer, together with the edit.
    const response = await editStep(
      withFixtureRevision(testAccountRequest(post({ parameters: { sql: "SELECT * FROM back_two", name: "back_one" } })), readEditRevision({ kind: "workflow", id: id })?.editRevision),
      { params: Promise.resolve({ id, stepId: first.id as string }) },
    );
    expect(response.status).toBe(200);
    const read = (await body(
      await readRecipe(testAccountRequest(post({})), { params: Promise.resolve({ id }) }),
    )).recipe as Json;
    expect((read.steps as Json[]).map((s) => (s.parameters as Json).name)).toEqual(["back_two", "back_one"]);
    expect((read.steps as Json[])[1].reads).toEqual(["back_two"]);
  }, 60_000);

  it("refuses a reorder that would put a producer after its consumer", async () => {
    const id = await newRecipe();
    const producer = await newStep(id, "SELECT 1 AS n", "reorder_one");
    await newStep(id, "SELECT count(*) AS n FROM reorder_one", "reorder_two");

    // Dragging the producer to the end breaks its consumer, not itself — the
    // case a check on only the moved step would pass.
    const response = await moveStep(withFixtureRevision(testAccountRequest(post({ ordinal: 1 })), readEditRevision({ kind: "workflow", id: id })?.editRevision), {
      params: Promise.resolve({ id, stepId: producer.id as string }),
    });
    expect(response.status).toBe(400);

    const read = (await body(
      await readRecipe(testAccountRequest(post({})), { params: Promise.resolve({ id }) }),
    )).recipe as Json;
    expect((read.steps as Json[])[0].id).toBe(producer.id);
  }, 60_000);
});

describe("authoring a step from a layer", () => {
  function layerOn(mapId: string, over: Partial<Layer> = {}): Layer {
    const now = new Date().toISOString();
    const layer: Layer = {
      id: randomUUID(),
      mapId,
      name: "Stations",
      sql: "SELECT * FROM stations",
      style: {} as Layer["style"],
      visible: true,
      tooltip: null,
      popup: null,
      publishedFields: null,
      inLegend: true,
      viz: { type: "points" } as Layer["viz"],
      filters: [],
      legendTitle: null,
      legendLabels: null,
      legendAttrs: null,
      ordinal: 0,
      createdAt: now,
      updatedAt: now,
      ...over,
    };
    insertLayer(layer);
    return layer;
  }

  it("takes the layer's SQL with its filters applied", async () => {
    const map = createMap(testAccountScope(), "M");
    const layer = layerOn(map.id, {
      filters: [{ field: "name", kind: "values", values: ["alex"] }],
    });
    const id = await newRecipe();

    const step = (await body(
      await addStep(
        withFixtureRevision(testAccountRequest(post({
          operation: "sql_step",
          parameters: { name: "from_layer" },
          fromLayerId: layer.id,
        })), readEditRevision({ kind: "workflow", id: id })?.editRevision),
        { params: Promise.resolve({ id }) },
      ),
    )).step as Json;

    const sql = (step.parameters as Json).sql as string;
    expect(sql).toContain("stations");
    // The filter is folded in — the row count changes, which is the proof the
    // criterion asks for.
    await runStep(testAccountRequest(post({})), {
      params: Promise.resolve({ id, stepId: step.id as string }),
    });
    await laneSettled();
    expect(getTableByName("from_layer")!.rowCount).toBe(1);

    // And it is a snapshot: editing the layer's filters afterwards does not
    // follow it.
    insertLayer({ ...layer, id: randomUUID(), filters: [] });
    const reread = (await body(
      await readStep(testAccountRequest(post({})), {
        params: Promise.resolve({ id, stepId: step.id as string }),
      }),
    )).step as Json;
    expect((reread.parameters as Json).sql).toBe(sql);
  }, 90_000);

  it("takes the source behind an aggregated layer, and says that it did", async () => {
    const map = createMap(testAccountScope(), "M");
    const id = await newRecipe();

    // Each aggregates by a different path, so each is asserted separately.
    const aggregated: [Layer["viz"], string][] = [
      [{ type: "hexbin", cellKm: 1.2, aggregate: { fn: "count" } }, "hex_out"],
      [{ type: "grid", cellKm: 1.2, aggregate: { fn: "count" } }, "grid_out"],
      [
        {
          type: "arc",
          origin: { kind: "lonlat", lon: "lon", lat: "lat" },
          dest: { kind: "lonlat", lon: "lon", lat: "lat" },
          height: 0.3,
        } as Layer["viz"],
        "od_out",
      ],
    ];
    for (const [viz, name] of aggregated) {
      const layer = layerOn(map.id, { viz });
      const step = (await body(
        await addStep(
          withFixtureRevision(testAccountRequest(post({
            operation: "sql_step",
            parameters: { name },
            fromLayerId: layer.id,
          })), readEditRevision({ kind: "workflow", id: id })?.editRevision),
          { params: Promise.resolve({ id }) },
        ),
      )).step as Json;

      const origin = step.origin as Json;
      expect(origin.substitutedSource).toBe(true);
      // Said in as many words, rather than left to be discovered.
      expect(String(origin.substitutionNote)).toMatch(/rows behind/i);

      await runStep(testAccountRequest(post({})), {
        params: Promise.resolve({ id, stepId: step.id as string }),
      });
      await laneSettled();
      // The row count is the source's, not the cells'.
      expect(getTableByName(name)!.rowCount).toBe(2);
    }
  }, 120_000);
});

describe("running through the surface", () => {
  it("runs one step and answers 202 with a run to poll", async () => {
    const id = await newRecipe();
    const step = await newStep(id, "SELECT count(*) AS n FROM stations", "api_run_out");

    const response = await runStep(testAccountRequest(post({})), {
      params: Promise.resolve({ id, stepId: step.id as string }),
    });
    expect(response.status).toBe(202);
    // A node's own run is one of the recipe's runs.
    expect(response.headers.get("Location")).toMatch(/^\/api\/recipes\/.+\/runs\//);
    const single = (await body(response)).run as Json;
    expect(single.kind).toBe("single");
    expect((single.members as Json[]).map((m) => m.stepId)).toEqual([step.id]);
    await cascadeSettled(single.id as string);
    const listedSingle = (await body(await listRuns(testAccountRequest(post({})), { params: Promise.resolve({ id }) }))).runs as Json[];
    expect(listedSingle.map((r) => r.id)).toContain(single.id);
    expect(((listedSingle[0].members as Json[])[0].attempt as Json).state).toBe("succeeded");

    const read = (await body(
      await readStep(testAccountRequest(post({})), {
        params: Promise.resolve({ id, stepId: step.id as string }),
      }),
    )).step as Json;
    expect(read.condition).toBe("current");
    expect((read.latestAttempt as Json).state).toBe("succeeded");
    expect((read.output as Json).name).toBe("api_run_out");
    // The inputs it recorded come from the parse of what ran.
    expect((read.inputs as Json[]).map((i) => i.name)).toEqual(["stations"]);
  }, 90_000);

  it("runs one run at a time: racing starts yield one run and one refusal naming it", async () => {
    const id = await newRecipe();
    await newStep(id, "SELECT count(*) AS n FROM stations", "lock_one");
    const [a, b] = await Promise.all([
      runRecipe(testAccountRequest(post({})), { params: Promise.resolve({ id }) }),
      runRecipe(testAccountRequest(post({})), { params: Promise.resolve({ id }) }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([202, 409]);
    const accepted = a.status === 202 ? a : b;
    const refused = a.status === 202 ? b : a;
    const run = (await body(accepted)).run as Json;
    const error = (await body(refused)).error as Json;
    expect(error.code).toBe("run_in_flight");
    expect(String(error.message)).toContain(run.id as string);
    // A later start while it is in flight is refused the same way; only one run exists.
    const later = await runRecipe(testAccountRequest(post({})), { params: Promise.resolve({ id }) });
    expect(later.status).toBe(409);
    await cascadeSettled(run.id as string);
    const listed = (await body(await listRuns(testAccountRequest(post({})), { params: Promise.resolve({ id }) }))).runs as Json[];
    expect(listed).toHaveLength(1);
    // Settled, the next start is accepted.
    const next = await runRecipe(testAccountRequest(post({})), { params: Promise.resolve({ id }) });
    expect(next.status).toBe(202);
    await cascadeSettled(((await body(next)).run as Json).id as string);
  }, 120_000);

  it("the race matrix: node and node, node and cascade, sent at once, yield one run and no attempt for the refused", async () => {
    const id = await newRecipe();
    const one = await newStep(id, "SELECT count(*) AS n FROM stations", "race_one");
    const two = await newStep(id, "SELECT count(*) AS m FROM stations", "race_two");
    const step = (stepId: string) => runStep(testAccountRequest(post({})), { params: Promise.resolve({ id, stepId }) });
    const settleAll = async () => {
      for (const r of (await body(await listRuns(testAccountRequest(post({})), { params: Promise.resolve({ id }) }))).runs as Json[]) {
        await cascadeSettled(r.id as string);
      }
    };
    const jobsOf = (stepId: string) => listJobs({ subjectId: stepId, subjectKind: "step" }).length;
    // Node and node.
    const [n1, n2] = await Promise.all([step(one.id as string), step(two.id as string)]);
    expect([n1.status, n2.status].sort()).toEqual([202, 409]);
    await settleAll();
    let runs = (await body(await listRuns(testAccountRequest(post({})), { params: Promise.resolve({ id }) }))).runs as Json[];
    expect(runs).toHaveLength(1);
    expect(jobsOf(one.id as string) + jobsOf(two.id as string)).toBe(1);
    // Node and cascade.
    const [s1, c1] = await Promise.all([step(one.id as string), runRecipe(testAccountRequest(post({})), { params: Promise.resolve({ id }) })]);
    expect([s1.status, c1.status].sort()).toEqual([202, 409]);
    await settleAll();
    runs = (await body(await listRuns(testAccountRequest(post({})), { params: Promise.resolve({ id }) }))).runs as Json[];
    expect(runs).toHaveLength(2);
    const refused = s1.status === 409 ? s1 : c1;
    expect(((await body(refused)).error as Json).code).toBe("run_in_flight");
  }, 120_000);

  it("a confirmed wide run starts exactly its members in order, and is refused when the set or the order differs", async () => {
    const id = await newRecipe();
    const one = await newStep(id, "SELECT count(*) AS n FROM stations", "conf_one");
    const two = await newStep(id, "SELECT n FROM conf_one", "conf_two");
    const plan = (await body(await runRecipe(testAccountRequest(post({ plan: true })), { params: Promise.resolve({ id }) }))).plan as Json;
    expect(plan.members).toEqual([one.id, two.id]);
    // The order alone differs: refused, nothing started.
    const reversed = await runRecipe(testAccountRequest(post({ members: [two.id, one.id] })), { params: Promise.resolve({ id }) });
    expect(reversed.status).toBe(409);
    expect(((await body(reversed)).error as Json).code).toBe("plan_changed");
    // The membership differs (a node added since the confirmation): refused.
    const three = await newStep(id, "SELECT 1 AS k", "conf_three");
    const stale = await runRecipe(testAccountRequest(post({ members: [one.id, two.id] })), { params: Promise.resolve({ id }) });
    expect(stale.status).toBe(409);
    expect(((await body(stale)).error as Json).code).toBe("plan_changed");
    expect(((await body(await listRuns(testAccountRequest(post({})), { params: Promise.resolve({ id }) }))).runs as Json[])).toHaveLength(0);
    // The plan as it stands now: accepted, exactly those members in that order.
    const ok = await runRecipe(testAccountRequest(post({ members: [one.id, two.id, three.id] })), { params: Promise.resolve({ id }) });
    expect(ok.status).toBe(202);
    const run = (await body(ok)).run as Json;
    expect((run.members as Json[]).map((m) => m.stepId)).toEqual([one.id, two.id, three.id]);
    await cascadeSettled(run.id as string);
  }, 120_000);

  it("plans a run before starting it, and reports the plan's blast radius", async () => {
    const id = await newRecipe();
    const producer = await newStep(id, "SELECT 1 AS n", "plan_one");
    const leaf = await newStep(id, "SELECT n FROM plan_one", "plan_two");

    const wide = (await body(
      await runRecipe(testAccountRequest(post({ plan: true, fromStepId: producer.id })), {
        params: Promise.resolve({ id }),
      }),
    )).plan as Json;
    expect(wide.wide).toBe(true);
    expect(wide.members).toHaveLength(2);

    const narrow = (await body(
      await runRecipe(testAccountRequest(post({ plan: true, fromStepId: leaf.id })), {
        params: Promise.resolve({ id }),
      }),
    )).plan as Json;
    expect(narrow.wide).toBe(false);
    expect(narrow.members).toEqual([leaf.id]);
  }, 60_000);

  it("runs a whole recipe as its own resource, listed and readable after", async () => {
    const id = await newRecipe();
    await newStep(id, "SELECT count(*) AS n FROM stations", "whole_one");
    await newStep(id, "SELECT n * 2 AS n FROM whole_one", "whole_two");

    const accepted = await runRecipe(testAccountRequest(post({})), {
      params: Promise.resolve({ id }),
    });
    expect(accepted.status).toBe(202);
    const run = (await body(accepted)).run as Json;
    await cascadeSettled(run.id as string);

    const reread = (await body(
      await readRun(testAccountRequest(post({})), {
        params: Promise.resolve({ id, runId: run.id as string }),
      }),
    )).run as Json;
    expect(reread.outcome).toBe("completed");
    expect((reread.outputs as Json[]).map((o) => o.name).sort()).toEqual([
      "whole_one",
      "whole_two",
    ]);
    // Each member carries its identity and its attempt.
    const members = reread.members as Json[];
    expect(members.map((m) => m.name)).toEqual(["whole_one", "whole_two"]);
    expect(members.every((m) => m.operation === "sql_step")).toBe(true);
    expect(members.map((m) => (m.attempt as Json).state)).toEqual(["succeeded", "succeeded"]);
    expect(((members[0].attempt as Json).output as Json).name).toBe("whole_one");

    const listed = (await body(
      await listRuns(testAccountRequest(post({})), { params: Promise.resolve({ id }) }),
    )).runs as Json[];
    expect(listed.map((r) => r.id)).toContain(run.id);
  }, 120_000);
});

describe("editing and removing through the surface", () => {
  it("names what a node reads now, before any run, by named input and by SQL", async () => {
    const id = await newRecipe("Reads");
    const bySql = await newStep(id, "SELECT name FROM stations", "reads_sql");
    expect(bySql.reads).toEqual(["stations"]);
    expect(bySql.inputs).toEqual([]);
    const byInput = await body(
      await addStep(
        withFixtureRevision(testAccountRequest(post({ operation: "filter_rows", parameters: { input: "stations", name: "reads_input" } })), readEditRevision({ kind: "workflow", id: id })?.editRevision),
        { params: Promise.resolve({ id }) },
      ),
    );
    expect((byInput.step as Json).reads).toEqual(["stations"]);
    // A node reading an earlier node's planned output names it, run or not.
    const chained = await newStep(id, "SELECT * FROM reads_sql", "reads_chain");
    expect(chained.reads).toEqual(["reads_sql"]);
  });

  it("present reads follow an edit while the recorded lineage stays what ran", async () => {
    const id = await newRecipe("Reads move");
    const step = await newStep(id, "SELECT name FROM stations", "reads_moved");
    await runStep(testAccountRequest(post({})), {
      params: Promise.resolve({ id, stepId: step.id as string }),
    });
    await laneSettled();
    const ran = (await body(
      await readStep(testAccountRequest(post({})), { params: Promise.resolve({ id, stepId: step.id as string }) }),
    )).step as Json;
    expect((ran.inputs as Json[]).map((i) => i.name)).toEqual(["stations"]);
    expect(ran.reads).toEqual(["stations"]);
    const edited = (await body(
      await editStep(
        withFixtureRevision(testAccountRequest(post({ parameters: { sql: "SELECT 1 AS n", name: "reads_moved" } })), readEditRevision({ kind: "workflow", id: id })?.editRevision),
        { params: Promise.resolve({ id, stepId: step.id as string }) },
      ),
    )).step as Json;
    expect(edited.reads).toEqual([]);
    expect((edited.inputs as Json[]).map((i) => i.name)).toEqual(["stations"]);
  }, 90_000);

  it("duplicates a run workflow into an independent copy that can run", async () => {
    const id = await newRecipe("Reach");
    const one = await newStep(id, "SELECT name FROM stations", "dup_one");
    const two = await body(
      await addStep(
        withFixtureRevision(testAccountRequest(post({ operation: "filter_rows", parameters: { input: "dup_one", field: "name", comparison: "equals", value: "alex", name: "dup_two" } })), readEditRevision({ kind: "workflow", id: id })?.editRevision),
        { params: Promise.resolve({ id }) },
      ),
    );
    // A literal and a comment carry an output's name; only the reference may move.
    const three = await newStep(id, "SELECT *, 'dup_one' AS tag FROM dup_one -- dup_one\nWHERE name <> 'dup_one'", "dup_three");
    expect(three.reads).toEqual(["dup_one"]);
    // The dynamic form the engine reads as a table.
    const four = await newStep(id, "SELECT count(*) AS c FROM query_table('dup_one')", "dup_four");
    expect(four.reads).toEqual(["dup_one"]);
    const started = await runRecipe(testAccountRequest(post({})), { params: Promise.resolve({ id }) });
    expect(started.status).toBe(202);
    const startedRun = (await body(started)).run as Json;
    await cascadeSettled(startedRun.id as string);
    const settled = (await body(
      await readRun(testAccountRequest(post({})), { params: Promise.resolve({ id, runId: startedRun.id as string }) }),
    )).run as Json;
    expect(settled.outcome, JSON.stringify(settled.members)).toBe("completed");
    // A pending edit on the first node, which the copy must not carry.
    await editStep(withFixtureRevision(testAccountRequest(post({ parameters: { sql: "SELECT name, lon FROM stations", name: "dup_one" } })), readEditRevision({ kind: "workflow", id: id })?.editRevision), {
      params: Promise.resolve({ id, stepId: one.id as string }),
    });
    const originalBefore = (await body(await readRecipe(testAccountRequest(post({})), { params: Promise.resolve({ id }) }))).recipe as Json;
    expect(((originalBefore.steps as Json[])[0].proposedParameters as Json).sql).toBe("SELECT name, lon FROM stations");

    const duplicated = await duplicateRecipeRoute(testAccountRequest(post({})), { params: Promise.resolve({ id }) });
    expect(duplicated.status).toBe(201);
    const copy = (await body(duplicated)).recipe as Json;
    expect(copy.name).toBe("Reach copy");
    expect(copy.origin).toBe("workflow");
    const cSteps = copy.steps as Json[];
    expect(cSteps.map((s) => s.operation)).toEqual(["sql_step", "filter_rows", "sql_step", "sql_step"]);
    expect(cSteps.map((s) => s.id)).not.toContain(one.id);
    expect(cSteps.map((s) => (s.parameters as Json).name)).toEqual(["dup_one_copy", "dup_two_copy", "dup_three_copy", "dup_four_copy"]);
    // Active definitions, not the pending one; no proposal, no output, no attempt.
    expect((cSteps[0].parameters as Json).sql).toBe("SELECT name FROM stations");
    expect(cSteps.every((s) => s.proposedParameters === null && s.output === null && s.latestAttempt === null)).toBe(true);
    expect(cSteps.map((s) => s.condition)).toEqual(["never_run", "never_run", "never_run", "never_run"]);
    // Reads redirected: by named input, and by SQL table reference only.
    expect((cSteps[1].parameters as Json).input).toBe("dup_one_copy");
    expect((cSteps[2].parameters as Json).sql).toBe("SELECT *, 'dup_one' AS tag FROM dup_one_copy -- dup_one\nWHERE name <> 'dup_one'");
    expect(cSteps[2].reads).toEqual(["dup_one_copy"]);
    expect((cSteps[3].parameters as Json).sql).toBe("SELECT count(*) AS c FROM query_table('dup_one_copy')");
    expect(cSteps[3].reads).toEqual(["dup_one_copy"]);
    expect(cSteps[0].reads).toEqual(["stations"]);
    expect((two.step as Json).id).not.toBe(cSteps[1].id);
    // The original is untouched: definitions, proposal, outputs, all as before.
    const originalAfter = (await body(await readRecipe(testAccountRequest(post({})), { params: Promise.resolve({ id }) }))).recipe as Json;
    expect(originalAfter).toEqual(originalBefore);
    expect((originalAfter.steps as Json[]).map((s) => (s.output as Json).name)).toEqual(["dup_one", "dup_two", "dup_three", "dup_four"]);

    // The copy runs end to end and writes its own datasets; the original's stand.
    const copyRun = await runRecipe(testAccountRequest(post({})), { params: Promise.resolve({ id: copy.id as string }) });
    expect(copyRun.status).toBe(202);
    await cascadeSettled(((await body(copyRun)).run as Json).id as string);
    const ranCopy = (await body(await readRecipe(testAccountRequest(post({})), { params: Promise.resolve({ id: copy.id as string }) }))).recipe as Json;
    expect((ranCopy.steps as Json[]).map((s) => s.condition)).toEqual(["current", "current", "current", "current"]);
    expect((ranCopy.summary as Json).status).toBe("up_to_date");
    for (const name of ["dup_one", "dup_two", "dup_three", "dup_four", "dup_one_copy", "dup_two_copy", "dup_three_copy", "dup_four_copy"]) {
      expect(getTableByName(name), name).not.toBeNull();
    }
    const originalStill = (await body(await readRecipe(testAccountRequest(post({})), { params: Promise.resolve({ id }) }))).recipe as Json;
    expect((originalStill.steps as Json[]).map((s) => (s.output as Json).id)).toEqual(
      (originalBefore.steps as Json[]).map((s) => (s.output as Json).id),
    );
    // A second copy finds the first copy's names taken and moves on.
    const again = (await body(await duplicateRecipeRoute(testAccountRequest(post({})), { params: Promise.resolve({ id }) }))).recipe as Json;
    expect((again.steps as Json[]).map((s) => (s.parameters as Json).name)).toEqual(["dup_one_copy_2", "dup_two_copy_2", "dup_three_copy_2", "dup_four_copy_2"]);
    expect(((again.steps as Json[])[1].parameters as Json).input).toBe("dup_one_copy_2");
  }, 120_000);

  it("refuses to duplicate what does not exist", async () => {
    expect((await duplicateRecipeRoute(testAccountRequest(post({})), { params: Promise.resolve({ id: "nope" }) })).status).toBe(404);
  });

  it("holds an edit as a proposal once the step has produced something", async () => {
    const id = await newRecipe();
    const step = await newStep(id, "SELECT 1 AS n", "prop_out");
    await runStep(testAccountRequest(post({})), {
      params: Promise.resolve({ id, stepId: step.id as string }),
    });
    await laneSettled();

    const edited = await body(
      await editStep(
        withFixtureRevision(testAccountRequest(post({ parameters: { sql: "SELECT 2 AS n", name: "prop_out" } })), readEditRevision({ kind: "workflow", id: id })?.editRevision),
        { params: Promise.resolve({ id, stepId: step.id as string }) },
      ),
    );
    expect(edited.applied).toBe("proposed");
    expect(((edited.step as Json).parameters as Json).sql).toBe("SELECT 1 AS n");
    expect(((edited.step as Json).proposedParameters as Json).sql).toBe(
      "SELECT 2 AS n",
    );
  }, 90_000);

  it("removes a step and says its output remains", async () => {
    const id = await newRecipe();
    const step = await newStep(id, "SELECT 1 AS n", "gone_step_out");
    await runStep(testAccountRequest(post({})), {
      params: Promise.resolve({ id, stepId: step.id as string }),
    });
    await laneSettled();

    const removed = await body(
      await removeStep(withFixtureRevision(testAccountRequest(post({})), readEditRevision({ kind: "workflow", id: id })?.editRevision), {
        params: Promise.resolve({ id, stepId: step.id as string }),
      }),
    );
    expect(removed.outputsRemain).toBe(true);
    // The answer says what is true of the dataset.
    expect(removed.output).toEqual({ name: "gone_step_out", state: "exists" });
    expect(removed.readers).toEqual([]);
    expect(getTableByName("gone_step_out")).not.toBeNull();
  }, 90_000);
});

describe("a malformed run body never widens into run-all", () => {
  /** Absence selects the whole recipe here, so anything present and wrong must
   * be refused rather than read as absent. */
  const raw = (payload: string) =>
    new Request("http://test/api/recipes/x/runs", { method: "POST", body: payload });

  it("refuses a truncated body instead of running everything", async () => {
    const id = await newRecipe();
    await newStep(id, "SELECT 1 AS n", "mal_one");
    await newStep(id, "SELECT 2 AS n", "mal_two");

    const response = await runRecipe(testAccountRequest(raw('{"fromStepId":')), {
      params: Promise.resolve({ id }),
    });
    expect(response.status).toBe(400);
    expect(((await body(response)).error as Json).code).toBe("invalid_request");
    // Nothing started.
    const runs = (await body(
      await listRuns(testAccountRequest(post({})), { params: Promise.resolve({ id }) }),
    )).runs as Json[];
    expect(runs).toEqual([]);
  }, 60_000);

  it("refuses a fromStepId of the wrong type", async () => {
    const id = await newRecipe();
    await newStep(id, "SELECT 1 AS n", "mal_three");
    const response = await runRecipe(testAccountRequest(raw('{"fromStepId": 7}')), {
      params: Promise.resolve({ id }),
    });
    expect(response.status).toBe(400);
  }, 60_000);

  it("still treats a genuinely absent body as run-all", async () => {
    const id = await newRecipe();
    await newStep(id, "SELECT 1 AS n", "mal_four");
    const response = await runRecipe(
      testAccountRequest(new Request("http://test/api/recipes/x/runs", { method: "POST" })),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(202);
    await cascadeSettled(((await body(response)).run as Json).id as string);
  }, 60_000);
});

describe("the workflow's project context", () => {
  it("outputs follow the workflow's project at the commit; re-runs and parent moves change nothing", async () => {
    const a = createProject(testAccountScope(), { name: "A" });
    const b = createProject(testAccountScope(), { name: "B" });
    const id = await newRecipe("Filed");
    changeMembers(a.id, { addRecipes: [id] });

    const step = await newStep(id, "SELECT * FROM stations", "filed_out");
    await runStep(testAccountRequest(post({})), {
      params: Promise.resolve({ id, stepId: step.id as string }),
    });
    await laneSettled();
    const out = getTableByName("filed_out")!;
    expect(tableProjectIds().get(out.id)).toEqual([a.id]);

    // Moving the workflow moves nothing that already exists.
    changeMembers(b.id, { addRecipes: [id] });
    expect(tableProjectIds().get(out.id)).toEqual([a.id]);

    // A re-run rewrites the same dataset (the replace path) and preserves
    // its memberships unchanged.
    await runStep(testAccountRequest(post({})), {
      params: Promise.resolve({ id, stepId: step.id as string }),
    });
    await laneSettled();
    const rerun = getTableByName("filed_out")!;
    expect(rerun.id).toBe(out.id);
    expect(tableProjectIds().get(rerun.id)).toEqual([a.id]);

    // A NEW output written after the move files where the workflow is at
    // that commit — not where it was when earlier outputs were made.
    const later = await newStep(id, "SELECT * FROM stations", "later_out");
    await runStep(testAccountRequest(post({})), {
      params: Promise.resolve({ id, stepId: later.id as string }),
    });
    await laneSettled();
    expect(
      tableProjectIds().get(getTableByName("later_out")!.id),
    ).toEqual([b.id]);
  }, 90_000);

  it("an unfiled workflow writes unfiled outputs", async () => {
    const id = await newRecipe("Loose");
    const step = await newStep(id, "SELECT * FROM stations", "loose_out");
    await runStep(testAccountRequest(post({})), {
      params: Promise.resolve({ id, stepId: step.id as string }),
    });
    await laneSettled();
    expect(
      tableProjectIds().get(getTableByName("loose_out")!.id),
    ).toBeUndefined();
  }, 90_000);
});
