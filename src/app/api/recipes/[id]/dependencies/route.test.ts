import { testAccountScope, testAccountRequest } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { insertTable, type DataTable } from "@/lib/metadata/tables";
import { createProject, fileTable } from "@/lib/metadata/projects";
import {
  addStep,
  createRecipe,
  editStep,
  recordOutput,
} from "@/lib/metadata/recipes";
import { GET } from "./route";

/**
 * The workflow-dependencies read, against independently seeded
 * fixtures: the expected set is the seeds' own, never the read's
 * answer.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
});

afterEach(async () => {
  closeMetadataDb();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

let n = 0;
function dataset(name: string, over: Partial<DataTable> = {}): DataTable {
  n += 1;
  return {
    id: `t-${name}-${n}`,
    name,
    sourceFilename: `${name}.csv`,
    format: "csv",
    file: `tables/${name}.parquet`,
    geometryColumn: "geometry",
    geometryType: "POINT",
    crsAssumed: false,
    headerSuspect: false,
    rowCount: 7,
    createdAt: "2026-09-01T00:00:00Z",
    source: "upload",
    sourceParams: null,
    importedAt: null,
    ...over,
  };
}

const read = async (recipeId: string) =>
  GET(testAccountRequest(new Request("http://test")), { params: Promise.resolve({ id: recipeId }) });

type Wire = {
  id: string;
  name: string;
  source: string;
  rowCount: number;
  projectIds: string[];
  geometryColumn: string | null;
  geometryType: string | null;
  producer: { id: string; name: string } | null;
};

describe("the datasets a workflow reads and writes", () => {
  it("returns one entry per registered read and per current output, an input read by several nodes once, an output read downstream once, nothing unrelated", async () => {
    const stations = dataset("stations", { rowCount: 30 });
    const districts = dataset("districts", { geometryType: "POLYGON" });
    const buffers = dataset("station_buffers", { source: "operation" });
    const joined = dataset("stations_by_district", { source: "operation" });
    const unrelated = dataset("harbor_depths");
    for (const t of [stations, districts, buffers, joined, unrelated]) insertTable(testAccountScope(), t);
    const berlin = createProject(testAccountScope(), { name: "Berlin" });
    fileTable(districts.id, berlin.id);

    const wf = createRecipe(testAccountScope(), "Station catchments");
    // Two nodes read stations: one declares it, one names it in SQL.
    const buffer = addStep(wf.id, {
      operation: "buffer",
      parameters: { input: "stations", distance: 100, name: "station_buffers" },
    });
    recordOutput(buffer.id, { id: buffers.id, name: buffers.name }, "2026-09-01T01:00:00Z");
    // The downstream node reads the first node's OUTPUT and a plain dataset.
    const join = addStep(wf.id, {
      operation: "sql_step",
      parameters: {
        sql: "SELECT s.name FROM stations s JOIN station_buffers b ON true JOIN districts d ON true",
        name: "stations_by_district",
      },
    });
    recordOutput(join.id, { id: joined.id, name: joined.name }, "2026-09-01T02:00:00Z");

    const response = await read(wf.id);
    expect(response.status).toBe(200);
    const { datasets } = (await response.json()) as { datasets: Wire[] };
    expect(datasets.map((d) => d.name)).toEqual([
      "districts",
      "station_buffers",
      "stations",
      "stations_by_district",
    ]);
    const byName = new Map(datasets.map((d) => [d.name, d]));
    expect(byName.get("stations")!.rowCount).toBe(30);
    expect(byName.get("stations")!.projectIds).toEqual([]);
    expect(byName.get("districts")!.projectIds).toEqual([berlin.id]);
    expect(byName.get("districts")!.geometryType).toBe("POLYGON");
    expect(byName.get("station_buffers")!.producer).toEqual({ editRevision: expect.stringMatching(/^[a-f0-9]{32}$/), lastChangedAt: expect.any(String), lastChangedBy: { name: "test-account", sqlName: "test_account" }, id: wf.id, name: "Station catchments", owned: true });
    expect(byName.get("stations")!.producer).toBeNull();
  });

  it("describes the current definition: a pending edit's reads over the active definition's", async () => {
    const stations = dataset("stations");
    const lanes = dataset("bike_lanes", { geometryType: "LINESTRING" });
    insertTable(testAccountScope(), stations);
    insertTable(testAccountScope(), lanes);
    const density = dataset("density", { source: "operation" });
    insertTable(testAccountScope(), density);
    const wf = createRecipe(testAccountScope(), "Lane density");
    const step = addStep(wf.id, {
      operation: "sql_step",
      parameters: { sql: "SELECT * FROM stations", name: "density" },
    });
    // A step that has produced something takes an edit as a PROPOSAL
    // (G3); the fixture asserts it got one, so the case tests what it
    // claims to.
    recordOutput(step.id, { id: density.id, name: density.name }, "2026-09-01T01:00:00Z");
    expect(editStep(step.id, { sql: "SELECT * FROM bike_lanes", name: "density" })).toBe("proposed");
    const { datasets } = (await (await read(wf.id)).json()) as { datasets: Wire[] };
    expect(datasets.map((d) => d.name)).toEqual(["bike_lanes", "density"]);
  });

  it("returns none for a workflow with no registered dependencies; unregistered names are not entries", async () => {
    const wf = createRecipe(testAccountScope(), "Empty");
    expect((await (await read(wf.id)).json()) as unknown).toMatchObject({ datasets: [], editRevision: expect.stringMatching(/^[a-f0-9]{32}$/) });
    addStep(wf.id, {
      operation: "sql_step",
      parameters: { sql: "SELECT * FROM not_registered_anywhere", name: "x" },
    });
    expect((await (await read(wf.id)).json()) as unknown).toMatchObject({ datasets: [], editRevision: expect.stringMatching(/^[a-f0-9]{32}$/) });
  });

  it("fails the whole read when one current definition cannot be analyzed — never an empty or partial answer", async () => {
    const stations = dataset("stations");
    insertTable(testAccountScope(), stations);
    const wf = createRecipe(testAccountScope(), "Broken");
    addStep(wf.id, {
      operation: "sql_step",
      parameters: { sql: "SELECT * FROM stations", name: "fine" },
    });
    addStep(wf.id, {
      operation: "sql_step",
      parameters: { sql: "SELECT FROM WHERE (((", name: "broken" },
    });
    const response = await read(wf.id);
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("dependencies_unresolved");
    expect(body.error.message).toContain("position 2");
  });

  it("404s an unknown workflow", async () => {
    const response = await read("nope");
    expect(response.status).toBe(404);
  });
});
