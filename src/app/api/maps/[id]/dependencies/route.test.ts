import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { insertTable, type DataTable } from "@/lib/metadata/tables";
import { createProject, fileTable } from "@/lib/metadata/projects";
import { addStep, createRecipe, recordOutput } from "@/lib/metadata/recipes";
import { createMap } from "@/lib/map-service";
import { insertLayer, type Layer } from "@/lib/metadata/maps";
import { normalizeStyle } from "@/lib/style/style";
import { GET } from "./route";

/**
 * The map-dependencies read, against independently seeded fixtures: the
 * expected set is established by the seeds, never by the read's own
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

const read = async (mapId: string) =>
  GET(new Request("http://test"), { params: Promise.resolve({ id: mapId }) });

let ordinal = 0;
/** Metadata-level seeding: layer creation's own binding validates
 * against real data, which these fixtures deliberately do not carry —
 * the read under test is parse-plus-registry, not the binder. */
function seedLayer(mapId: string, name: string, sql: string): void {
  ordinal += 1;
  insertLayer({
    id: `layer-${name}-${ordinal}`,
    mapId,
    name,
    sql,
    style: normalizeStyle({}),
    visible: true,
    tooltip: null,
    popup: null,
    publishedFields: null,
    inLegend: true,
    viz: { type: "points" },
    filters: [],
    legendTitle: null,
    legendLabels: null,
    legendAttrs: null,
    ordinal,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
  } satisfies Layer);
}

describe("the datasets a map draws from", () => {
  it("carries each dataset's geometry column and sampled type, independently seeded", async () => {
    // Six identities the tiles distinguish: the expectations are the
    // seeds' own, never derived from the read or the classifier.
    const seeds: [string, string | null, string | null][] = [
      ["pts", "geometry", "POINT"],
      ["lns", "geom", "MULTILINESTRING"],
      ["pgs", "geometry", "POLYGON"],
      ["mix", "geometry", "POINT+LINESTRING"],
      ["unsampled", "geometry", null],
      ["plain", null, null],
    ];
    for (const [name, geometryColumn, geometryType] of seeds) {
      insertTable(testAccountScope(), dataset(name, { geometryColumn, geometryType }));
    }
    const map = createMap(testAccountScope(), "Every kind");
    seedLayer(
      map.id,
      "all",
      "SELECT 1 FROM pts, lns, pgs, mix, unsampled, plain",
    );
    const response = await read(map.id);
    expect(response.status).toBe(200);
    const { datasets } = (await response.json()) as {
      datasets: { name: string; geometryColumn: string | null; geometryType: string | null }[];
    };
    const got = new Map(datasets.map((d) => [d.name, d]));
    for (const [name, geometryColumn, geometryType] of seeds) {
      expect(got.get(name)?.geometryColumn, name).toBe(geometryColumn);
      expect(got.get(name)?.geometryType, name).toBe(geometryType);
    }
  });

  it("returns each used registered dataset once, complete per layer, unrelated absent, facts from the records", async () => {
    const stations = dataset("stations", { rowCount: 30 });
    const districts = dataset("districts", { rowCount: 6 });
    const unrelated = dataset("harbor_depths");
    insertTable(testAccountScope(), stations);
    insertTable(testAccountScope(), districts);
    insertTable(testAccountScope(), unrelated);
    const berlin = createProject(testAccountScope(), { name: "Berlin" });
    const flood = createProject(testAccountScope(), { name: "Flood" });
    fileTable(districts.id, berlin.id);
    fileTable(districts.id, flood.id);

    const map = createMap(testAccountScope(), "Stations map");
    // stations is used by TWO layers; one layer reads TWO datasets.
    seedLayer(map.id, "a", "SELECT * FROM stations");
    seedLayer(map.id, "b", "SELECT s.name FROM stations s JOIN districts d ON true");

    const response = await read(map.id);
    expect(response.status).toBe(200);
    const { datasets } = (await response.json()) as {
      datasets: {
        id: string;
        name: string;
        source: string;
        rowCount: number;
        projectIds: string[];
        producer: unknown;
      }[];
    };
    expect(datasets.map((d) => d.name)).toEqual(["districts", "stations"]);
    const byName = new Map(datasets.map((d) => [d.name, d]));
    expect(byName.get("stations")!.rowCount).toBe(30);
    expect(byName.get("stations")!.source).toBe("upload");
    expect(byName.get("stations")!.projectIds).toEqual([]);
    expect(new Set(byName.get("districts")!.projectIds)).toEqual(
      new Set([berlin.id, flood.id]),
    );
    expect(byName.get("stations")!.producer).toBeNull();
  });

  it("names a workflow-origin producer by its current output; a builder-origin recipe is never one", async () => {
    const out = dataset("station_buffers", { source: "operation" });
    const toolOut = dataset("tool_result", { source: "operation" });
    insertTable(testAccountScope(), out);
    insertTable(testAccountScope(), toolOut);

    const wf = createRecipe(testAccountScope(), "Station catchments");
    const step = addStep(wf.id, {
      operation: "sql_step",
      parameters: { sql: "SELECT 1", name: "station_buffers" },
    });
    recordOutput(step.id, { id: out.id, name: out.name }, "2026-09-01T01:00:00Z");

    const builder = createRecipe(testAccountScope(), "Tool recipe", undefined, "builder");
    const bStep = addStep(builder.id, {
      operation: "sql_step",
      parameters: { sql: "SELECT 1", name: "tool_result" },
    });
    recordOutput(
      bStep.id,
      { id: toolOut.id, name: toolOut.name },
      "2026-09-01T01:00:00Z",
    );

    const map = createMap(testAccountScope(), "Derived map");
    seedLayer(map.id, "a", "SELECT * FROM station_buffers JOIN tool_result ON true");

    const response = await read(map.id);
    const { datasets } = (await response.json()) as {
      datasets: { name: string; producer: { name: string } | null }[];
    };
    const byName = new Map(datasets.map((d) => [d.name, d]));
    expect(
      (byName.get("station_buffers") as unknown as { source: string }).source,
    ).toBe("operation");
    expect(byName.get("station_buffers")!.producer).toEqual({
      id: wf.id,
      name: "Station catchments",
    });
    expect(byName.get("tool_result")!.producer).toBeNull();
  });

  it("a map with no used datasets returns an empty set; an unknown map is missing", async () => {
    const map = createMap(testAccountScope(), "Blank");
    const response = await read(map.id);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { datasets: unknown[] }).datasets).toEqual([]);

    const missing = await read("no-such-map");
    expect(missing.status).toBe(404);
  });

  it("an unanalyzable layer fails the whole read, never a partial checklist", async () => {
    const stations = dataset("stations");
    insertTable(testAccountScope(), stations);
    const map = createMap(testAccountScope(), "Broken");
    seedLayer(map.id, "ok", "SELECT * FROM stations");
    seedLayer(map.id, "broken", "SELEC nonsense FRM nowhere ((");

    const response = await read(map.id);
    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("dependencies_unresolved");
    expect(body.error.message).toContain("broken");
  });
});
