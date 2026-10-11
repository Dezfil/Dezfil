import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { dataDir } from "@/lib/config";
import { resetQueryInstance } from "@/lib/duckdb";
import { addStep, createRecipe } from "@/lib/metadata/recipes";
import { laneSettled, resetLane } from "@/lib/operations/lane";
import { startStepRun } from "@/lib/operations/step-execution";
import { testAccountScope } from "@/lib/test-support/accounts";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";
import { SEEDS, buildTemplate, installFixture, type BuiltTemplate } from "../../../test-support/templates/builder";
import * as shippedIndex from "./shipped-index";

/**
 * Making a copy of a workflow example: its workflow lands beside its map in
 * the new project, each step the copier's own and reading the datasets and
 * the earlier outputs as landed; each bundled result is the copier's output
 * of its step, recorded with no job and no run, so the workflow reads it as
 * a copied result (no last success, and a mark naming the template and its
 * version) until the first run of that step replaces it. The canvas layout
 * comes with it, every position under the copy's step or the dataset as
 * landed and every note kept. Read through the real routes.
 */

const ORIGIN = "http://instance.test";
const TEMPLATE_RESULT = { template: "busy-stations", version: 1 };

let built: string;
let W1: BuiltTemplate, WX: BuiltTemplate;
let f: ReturnType<typeof instanceSettingsFixture>;
let dir: string;
let downloadFolder: string;

beforeAll(async () => {
  built = await mkdtemp(path.join(process.cwd(), ".tmp-test-template-copy-workflow-"));
  W1 = await buildTemplate(path.join(built, "w1"), { kind: "workflow", id: "busy-stations" });
  WX = await buildTemplate(path.join(built, "wx"), { kind: "workflow", id: "stray-steps", edit: SEEDS.stepReferenceOutside });
});
afterAll(async () => { await rm(built, { recursive: true, force: true }); });

beforeEach(async () => {
  f = instanceSettingsFixture();
  resetLane();
  resetQueryInstance();
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-template-copy-workflow-run-"));
  vi.spyOn(shippedIndex, "shippedTemplatesDir").mockReturnValue(path.join(dir, "no-shipped-set"));
  const downloads = path.join(dataDir(), "templates");
  downloadFolder = path.join(downloads, "busy-stations", "1");
  await installFixture(W1, downloadFolder, { kind: "catalogue", origin: "https://catalogue.example" });
  await installFixture(WX, path.join(downloads, "stray-steps", "1"), { kind: "catalogue", origin: "https://catalogue.example" });
});
afterEach(async () => {
  await laneSettled();
  resetLane();
  resetQueryInstance();
  f.close();
  await rm(dir, { recursive: true, force: true });
});

const byCookie = () => ({ cookie: `dezfil_session=${f.member.secret}`, origin: ORIGIN });

async function call(method: string, route: string, body?: unknown) {
  const response = await dispatchAssistantTestRoute(socketRequest(new Request(`${ORIGIN}${route}`, {
    method,
    headers: { ...byCookie(), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })));
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, unknown> | null, text };
}

interface Step {
  id: string; operation: string; parameters: Record<string, unknown>; reads: string[];
  output: { id: string; name: string; runId: string | null; jobId: string | null } | null;
  lastSuccessAt: string | null; latestAttempt: unknown; condition: string;
  templateResult: { template: string; version: number } | null;
}
interface Copied {
  project: { id: string; recipeCount: number; mapCount: number; tableCount: number };
  members: { maps: { id: string }[]; recipes: { id: string; name: string; projectId: string | null }[]; tables: { id: string; name: string; source: string }[] };
}

async function copyExample(): Promise<Copied & { recipe: { id: string; home: string; steps: Step[] }; layers: { id: string; name: string; sql: string }[] }> {
  const response = await call("POST", "/api/templates/busy-stations/copy");
  expect(response.status, response.text).toBe(201);
  const copied = response.body as unknown as Copied;
  const recipe = (await call("GET", `/api/recipes/${copied.members.recipes[0].id}`)).body!.recipe as { id: string; home: string; steps: Step[] };
  const map = (await call("GET", `/api/maps/${copied.members.maps[0].id}`)).body as unknown as { layers: { id: string; name: string; sql: string }[] };
  return { ...copied, recipe, layers: map.layers };
}

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const tableRow = (id: string) => f.db.prepare("SELECT * FROM data_tables WHERE id = ?").get(id) as { name: string; file: string; source: string; source_params: string | null };
const fileOf = async (id: string) => sha(await readFile(path.join(dataDir(), tableRow(id).file)));
const datasetId = (copied: Copied, name: string) => copied.members.tables.find((t) => t.name === name)!.id;
const layout = async (recipeId: string) => (await call("GET", `/api/recipes/${recipeId}/layout`)).body!.layout as {
  steps: Record<string, { x: number; y: number }>; sources: Record<string, { x: number; y: number }>; notes: { id: string; text: string }[];
};

async function folderHashes(folder: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (at: string, prefix: string) => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(at, entry.name), relative);
      else out[relative] = sha(await readFile(path.join(at, entry.name)));
    }
  };
  await walk(folder, "");
  return out;
}

describe("a copy of a workflow example", () => {
  it("lands its workflow in the project, each step its own, each bundled result the copier's output with no job and no run, read as a copied result", async () => {
    const copied = await copyExample();
    expect(copied.project).toMatchObject({ mapCount: 1, recipeCount: 1, tableCount: 4 });
    expect(copied.members.tables.map((t) => t.name).sort()).toEqual(["busy_stations", "districts", "station_rings", "stations"]);
    expect(copied.members.tables.every((t) => t.source === "template")).toBe(true);
    expect(copied.members.recipes[0]).toMatchObject({ name: "Busy stations", projectId: copied.project.id });
    const { recipe } = copied;
    expect(recipe.home).toBe("member");

    const [busy, rings] = recipe.steps;
    expect(recipe.steps.map((s) => s.operation)).toEqual(["sql_step", "buffer"]);
    expect(recipe.steps.map((s) => s.id)).not.toContain("step-busy");
    expect(busy.parameters).toEqual({ sql: "SELECT * FROM stations WHERE riders > 100", name: "busy_stations" });
    expect(rings.parameters).toEqual({ input: "busy_stations", distance: 250, name: "station_rings" });
    for (const [step, name] of [[busy, "busy_stations"], [rings, "station_rings"]] as const) {
      expect(step.output).toMatchObject({ id: datasetId(copied, name), name, runId: null, jobId: null });
      expect(step.lastSuccessAt).toBeNull();
      expect(step.templateResult).toEqual(TEMPLATE_RESULT);
      expect(step.latestAttempt).toBeNull();
      expect(["broken", "output_missing", "output_unavailable"]).not.toContain(step.condition);
    }
    // No run was invented: no job, no run, and the runner's record names
    // neither.
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM operation_jobs").get()).toEqual({ n: 0 });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM cascade_runs").get()).toEqual({ n: 0 });
    expect(f.db.prepare("SELECT runner_id, output_table_name, job_id, run_id FROM step_runner_outputs ORDER BY output_table_name").all()).toEqual([
      { runner_id: "member", output_table_name: "busy_stations", job_id: null, run_id: null },
      { runner_id: "member", output_table_name: "station_rings", job_id: null, run_id: null },
    ]);

    // The outputs draw before any run: the map's layers read them.
    expect(Object.fromEntries(copied.layers.map((l) => [l.name, l.sql]))).toEqual({ Rings: "SELECT * FROM station_rings", "Busy stations": "SELECT * FROM busy_stations" });
    for (const [layer, count, type] of [[copied.layers[0], 4, "POLYGON"], [copied.layers[1], 4, "POINT"]] as const) {
      const render = await call("GET", `/api/layers/${layer.id}/render`);
      expect(render.body).toMatchObject({ ok: true, featureCount: count, geometryType: type });
    }
  });

  it("keeps the canvas: every position under the copy's step or the dataset as landed, every note, no node unplaced and no source loose", async () => {
    const template = (W1.files.documents.get("workflows/workflow.json")!.layout) as {
      steps: Record<string, { x: number; y: number }>; sources: Record<string, { x: number; y: number }>; notes: unknown[];
    };
    await copyExample();
    // The second copy lands its datasets suffixed, so a position left under
    // the template's dataset name would draw a source nothing reads.
    const second = await copyExample();
    const [busy, rings] = second.recipe.steps;
    expect(busy.parameters).toEqual({ sql: "SELECT * FROM stations_2 WHERE riders > 100", name: "busy_stations_2" });
    expect(rings.parameters).toEqual({ input: "busy_stations_2", distance: 250, name: "station_rings_2" });
    const read = await layout(second.recipe.id);
    expect(read.steps).toEqual({ [busy.id]: template.steps["step-busy"], [rings.id]: template.steps["step-rings"] });
    expect(read.sources).toEqual({ stations_2: template.sources.stations });
    const readByAStep = new Set(second.recipe.steps.flatMap((s) => s.reads));
    for (const source of Object.keys(read.sources)) expect(readByAStep.has(source), source).toBe(true);
    expect(read.notes).toEqual(template.notes);
    expect(Object.fromEntries(second.layers.map((l) => [l.name, l.sql]))).toEqual({ Rings: "SELECT * FROM station_rings_2", "Busy stations": "SELECT * FROM busy_stations_2" });
  });

  it("a copier whose workflow declares a result's name lands that result, and the step declaring it, under the next free name", async () => {
    const recipe = createRecipe(testAccountScope(f.db, "member"), "Mine", f.db);
    addStep(recipe.id, { operation: "sql_step", parameters: { sql: "SELECT 1 AS one", name: "busy_stations" } }, f.db);
    const copied = await copyExample();
    expect(copied.members.tables.map((t) => t.name).sort()).toEqual(["busy_stations_2", "districts", "station_rings", "stations"]);
    const [busy, rings] = copied.recipe.steps;
    expect(busy.parameters.name).toBe("busy_stations_2");
    expect(rings.parameters.input).toBe("busy_stations_2");
    expect(busy.output?.name).toBe("busy_stations_2");
  });

  it("a run in the copy replaces only that copy's output, its step then a run's with the mark gone; the template and another copy unchanged", async () => {
    const first = await copyExample();
    const second = await copyExample();
    const templateBefore = await folderHashes(downloadFolder);
    const secondBefore = JSON.stringify(await Promise.all(second.members.tables.map(async (t) => [tableRow(t.id), await fileOf(t.id)])));
    const busyId = datasetId(first, "busy_stations");
    const busyFile = tableRow(busyId).file;

    const job = await startStepRun(testAccountScope(f.db, "member"), first.recipe.steps[0].id);
    await laneSettled();
    const after = (await call("GET", `/api/recipes/${first.recipe.id}`)).body!.recipe as { steps: Step[] };
    const [busy, rings] = after.steps;
    expect(busy.output).toMatchObject({ id: busyId, name: "busy_stations", jobId: job.id });
    expect(busy.lastSuccessAt).not.toBeNull();
    expect(busy.templateResult).toBeNull();
    expect(tableRow(busyId)).toMatchObject({ name: "busy_stations", source: "operation" });
    expect(tableRow(busyId).file).not.toBe(busyFile);
    // The step not run is still the copied result.
    expect(rings.templateResult).toEqual(TEMPLATE_RESULT);
    expect(rings.lastSuccessAt).toBeNull();
    const render = await call("GET", `/api/layers/${first.layers[1].id}/render`);
    expect(render.body).toMatchObject({ ok: true, featureCount: 4 });

    expect(await folderHashes(downloadFolder)).toEqual(templateBefore);
    expect(JSON.stringify(await Promise.all(second.members.tables.map(async (t) => [tableRow(t.id), await fileOf(t.id)])))).toBe(secondBefore);
    const untouched = (await call("GET", `/api/recipes/${second.recipe.id}`)).body!.recipe as { steps: Step[] };
    for (const step of untouched.steps) expect(step).toMatchObject({ lastSuccessAt: null, templateResult: TEMPLATE_RESULT });
  });

  it("refuses an example whose step reads a dataset the copy does not make, with nothing created", async () => {
    const response = await call("POST", "/api/templates/stray-steps/copy");
    expect(response.status).toBe(422);
    expect(response.body).toEqual({ error: { code: "template_reference_unbound", message: expect.stringContaining('"roads"') } });
    for (const table of ["projects", "maps", "recipes", "data_tables"]) {
      expect((f.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_id = 'member'`).get() as { n: number }).n, table).toBe(0);
    }
  });
});
