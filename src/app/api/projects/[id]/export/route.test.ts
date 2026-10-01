import { testAccountScope, testAccountRequest } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { insertMap, type MapRecord } from "@/lib/metadata/maps";
import { insertTable, type DataTable } from "@/lib/metadata/tables";
import { createProject } from "@/lib/metadata/projects";
import { addStep, createRecipe, recordOutput } from "@/lib/metadata/recipes";
import { writeLayout } from "@/lib/operations/recipe-layout";
import { ingestFile } from "@/lib/ingest/ingest";
import { GET, POST } from "./route";

/**
 * The 16-C export capability: the archive is read back with a reader
 * independent of the writer (jszip reads; yazl wrote) and inspected
 * against independently authored expectations — the entry list, the
 * manifest mapping, the projection deny-lists against seeded
 * publication and runtime facts, the pre-request artifact digest,
 * canonical-order collision suffixes, the refusals, single-use
 * redemption and staging cleanup.
 */

let dir: string;
let data: string;

beforeEach(async () => {
  dir = await mkdtemp();
  data = path.join(dir, "data");
  process.env.DEZFIL_DATA_DIR = data;
  await mkdir(path.join(data, "tables"), { recursive: true });
  closeMetadataDb();
});

async function mkdtemp(): Promise<string> {
  const { mkdtemp: make } = await import("node:fs/promises");
  return make(path.join(process.cwd(), ".tmp-test-"));
}

afterEach(async () => {
  closeMetadataDb();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

const at = (n: number) => new Date(1756700000000 + n * 1000).toISOString();

function seedMap(
  id: string,
  name: string,
  when: string,
  publishToken: string | null = null,
): MapRecord {
  const map: MapRecord = {
    id,
    name,
    viewport: { lng: 13.4, lat: 52.5, zoom: 10 },
    basemap: null,
    customBasemap: null,
    basemapLayers: null,
    note: null,
    legendCorner: null,
    legendOrder: null,
    timeline: null,
    widgets: [],
    widgetsPublished: true,
    publishToken,
    publishedAt: publishToken ? when : null,
    createdAt: when,
    updatedAt: when,
  };
  insertMap(testAccountScope(), map);
  return map;
}

async function seedDataset(
  id: string,
  name: string,
  bytes: Buffer,
): Promise<DataTable> {
  const table: DataTable = {
    id,
    name,
    sourceFilename: `${name}.csv`,
    format: "csv",
    file: `tables/${name}.parquet`,
    geometryColumn: "geometry",
    geometryType: "POINT",
    crsAssumed: false,
    headerSuspect: false,
    rowCount: 3,
    createdAt: at(1),
    source: "upload",
    sourceParams: null,
    importedAt: null,
  };
  insertTable(testAccountScope(), table);
  await writeFile(path.join(data, table.file), bytes);
  return table;
}

const post = async (projectId: string, body: Record<string, unknown>) =>
  POST(
    testAccountRequest(new Request("http://test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prepare: true, ...body }),
    })),
    { params: Promise.resolve({ id: projectId }) },
  );

const redeem = async (projectId: string, ticket: string, key: string) =>
  GET(
    testAccountRequest(new Request(
      `http://test?ticket=${encodeURIComponent(ticket)}&key=${encodeURIComponent(key)}`,
    )),
    { params: Promise.resolve({ id: projectId }) },
  );

const sha256 = (b: Buffer | Uint8Array) =>
  createHash("sha256").update(b).digest("hex");

const stagingResidue = async () =>
  readdir(path.join(data, "exports")).catch(() => [] as string[]);

describe("the project export capability", () => {
  it("packages the chosen subset: manifest, projections, digests, order", async () => {
    // The world, independently authored: two same-named maps (the
    // newer published with a seeded credential), a workflow with
    // runtime facts and a layout, three datasets with known bytes.
    seedMap("m-old", "Transit map", at(1));
    seedMap("m-new", "Transit map", at(3), "tok-secret-value");
    const recipe = createRecipe(testAccountScope(), "Catchments", undefined, "workflow");
    const step = addStep(recipe.id, {
      operation: "sql_step",
      parameters: { sql: "SELECT 1 AS x", name: "catch_out" },
    });
    const outBytes = Buffer.from("parquet-bytes-out");
    const tOut = await seedDataset("t-out", "catch_out", outBytes);
    recordOutput(step.id, { id: tOut.id, name: tOut.name }, at(5));
    writeLayout(testAccountScope(), recipe.id, {
      steps: { [step.id]: { x: 40, y: 80 } },
      sources: {},
      notes: [],
    });
    const aBytes = Buffer.from("parquet-bytes-a");
    const tA = await seedDataset("t-a", "stations", aBytes);
    const tLeft = await seedDataset("t-left", "left_out", Buffer.from("x"));
    const project = createProject(testAccountScope(), {
      name: "Berlin mobility study",
      note: "The staged note",
      members: {
        addMaps: ["m-old", "m-new"],
        addRecipes: [recipe.id],
        addTables: [tA.id, tOut.id, tLeft.id],
      },
    });
    const digestBefore = sha256(aBytes);

    // Everything chosen except one dataset; the file name exercises
    // the shared rule end to end.
    const prepared = await post(project.id, {
      maps: ["m-old", "m-new"],
      workflows: [recipe.id],
      datasets: [tA.id, tOut.id],
      file: "  Berlin Mobility Study!  ",
    });
    expect(prepared.status).toBe(200);
    const grant = (await prepared.json()) as {
      ticket: string;
      key: string;
      filename: string;
      size: number;
    };
    expect(grant.filename).toBe("berlin-mobility-study.zip");
    expect(grant.size).toBeGreaterThan(0);

    const download = await redeem(project.id, grant.ticket, grant.key);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/zip");
    expect(download.headers.get("content-length")).toBe(String(grant.size));
    expect(download.headers.get("content-disposition")).toContain(
      'filename="berlin-mobility-study.zip"',
    );
    const bytes = Buffer.from(await download.arrayBuffer());
    expect(bytes.length).toBe(grant.size);

    // Read back with the INDEPENDENT reader.
    const zip = await JSZip.loadAsync(bytes);
    const entries = Object.keys(zip.files)
      .filter((k) => !zip.files[k].dir)
      .sort();
    const root = "berlin-mobility-study.dezfil";
    // The independently authored entry list: newest-first canonical
    // order gives the newer map the bare slug and the older the
    // ordinal suffix; the left-out dataset is absent.
    expect(entries).toEqual(
      [
        `${root}/project.json`,
        `${root}/maps/transit-map.json`,
        `${root}/maps/transit-map-2.json`,
        `${root}/workflows/catchments.json`,
        `${root}/datasets/stations.parquet`,
        `${root}/datasets/catch_out.parquet`,
      ].sort(),
    );

    const json = async (name: string) =>
      JSON.parse(await zip.files[`${root}/${name}`].async("string"));
    const manifest = await json("project.json");
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.generator).toBe("dezfil");
    expect(typeof manifest.exportedAt).toBe("string");
    expect(manifest.project).toEqual({
      name: "Berlin mobility study",
      note: "The staged note",
    });
    expect(manifest.contents.maps).toEqual([
      { id: "m-new", name: "Transit map", file: "maps/transit-map.json" },
      { id: "m-old", name: "Transit map", file: "maps/transit-map-2.json" },
    ]);
    expect(manifest.contents.workflows).toEqual([
      { id: recipe.id, name: "Catchments", file: "workflows/catchments.json" },
    ]);
    // Equal created_at ties break by name, per the documented listing
    // order the canonical order rides.
    expect(manifest.contents.datasets).toEqual([
      // The effective format rides beside the file (additive).
      // Each names whose it is and the name its exporter types (additive).
      {
        id: tOut.id,
        name: "catch_out",
        qualifiedName: "catch_out",
        owner: { name: "test-account", sqlName: "test_account" },
        file: "datasets/catch_out.parquet",
        format: "geoparquet",
      },
      {
        id: tA.id,
        name: "stations",
        qualifiedName: "stations",
        owner: { name: "test-account", sqlName: "test_account" },
        file: "datasets/stations.parquet",
        format: "geoparquet",
      },
    ]);
    expect(manifest.exportedBy).toEqual({ sqlName: "test_account" });

    // The map projection: the published map's document carries neither
    // the credential nor the fact nor the membership; the seeded token
    // appears in NO JSON entry of the archive.
    const published = await json("maps/transit-map.json");
    expect(published.id).toBe("m-new");
    expect(published.publishToken).toBeUndefined();
    expect(published.publishedAt).toBeUndefined();
    expect(published.projectId).toBeUndefined();
    expect(published.layers).toEqual([]);
    for (const name of entries.filter((e) => e.endsWith(".json"))) {
      const text = await zip.files[name].async("string");
      expect(text).not.toContain("tok-secret-value");
    }

    // The workflow projection: definition + the layout annex, none of
    // the wire's runtime — the recorded output identity above proves
    // the deny-list against a real seeded fact.
    const workflow = await json("workflows/catchments.json");
    expect(workflow.name).toBe("Catchments");
    expect(workflow.projectId).toBeUndefined();
    expect(workflow.steps).toEqual([
      {
        id: step.id,
        ordinal: step.ordinal,
        operation: "sql_step",
        parameters: { sql: "SELECT 1 AS x", name: "catch_out" },
        origin: null,
      },
    ]);
    expect(workflow.layout.steps[step.id]).toEqual({ x: 40, y: 80 });
    const wfText = JSON.stringify(workflow);
    expect(wfText).not.toContain("latestAttempt");
    expect(wfText).not.toContain('catch_out","id":"t-out');
    expect(wfText).not.toContain('"output"');

    // Byte identity, against the digest recorded before the request.
    const stations =
      await zip.files[`${root}/datasets/stations.parquet`].async("uint8array");
    expect(sha256(stations)).toBe(digestBefore);

    // The staged file is deleted once the stream settles.
    await expect.poll(stagingResidue).toEqual([]);
  });

  it("refuses an unknown project, a non-member id and an empty selection", async () => {
    seedMap("m-1", "Solo", at(1));
    const project = createProject(testAccountScope(), {
      name: "Shelf",
      members: { addMaps: ["m-1"] },
    });
    const unknown = await post("p-none", { maps: ["m-1"], file: "x" });
    expect(unknown.status).toBe(404);

    seedMap("m-outside", "Outside", at(2));
    const outside = await post(project.id, {
      maps: ["m-outside"],
      file: "x",
    });
    expect(outside.status).toBe(400);
    const refusal = (await outside.json()) as {
      error: { message: string };
    };
    expect(refusal.error.message).toContain("m-outside");

    const empty = await post(project.id, { file: "x" });
    expect(empty.status).toBe(400);
    expect(
      ((await empty.json()) as { error: { message: string } }).error.message,
    ).toContain("Nothing chosen");

    const malformed = await post(project.id, { maps: [7], file: "x" });
    expect(malformed.status).toBe(400);
    await expect.poll(stagingResidue).toEqual([]);
  });

  it("refuses a directly filed builder-origin recipe while exporting a workflow-origin recipe", async () => {
    const project = createProject(testAccountScope(), { name: "Workflow shelf" });
    const workflow = createRecipe(testAccountScope(), "Exported workflow", undefined, "workflow");
    const builder = createRecipe(testAccountScope(), "Builder tool", undefined, "builder");
    metadataDb()
      .prepare(`UPDATE recipes SET project_id = ? WHERE id IN (?, ?)`)
      .run(project.id, workflow.id, builder.id);

    const refused = await post(project.id, {
      workflows: [builder.id],
      file: "builder",
    });
    expect(refused.status).toBe(400);
    expect(
      ((await refused.json()) as { error: { code: string } }).error.code,
    ).toBe("invalid_request");

    const accepted = await post(project.id, {
      workflows: [workflow.id],
      file: "workflow",
    });
    expect(accepted.status).toBe(200);
  });

  it("a failed assembly is a refusal with no residue, never a truncated success", async () => {
    const t = await seedDataset("t-gone", "vanishing", Buffer.from("y"));
    const project = createProject(testAccountScope(), {
      name: "Shelf",
      members: { addTables: [t.id] },
    });
    // The artifact vanishes before assembly (the injected failure).
    await rm(path.join(data, t.file));
    const failed = await post(project.id, { datasets: [t.id], file: "x" });
    expect(failed.status).toBe(500);
    const body = (await failed.json()) as { error: { code: string } };
    expect(body.error.code).toBe("export_failed");
    await expect.poll(stagingResidue).toEqual([]);
  });

  it("without prepare, the attachment streams directly (the agent road)", async () => {
    const t = await seedDataset("t-d", "direct", Buffer.from("direct-bytes"));
    const project = createProject(testAccountScope(), {
      name: "Shelf",
      members: { addTables: [t.id] },
    });
    const res = await POST(
      testAccountRequest(new Request("http://test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ datasets: [t.id], file: "direct" }),
      })),
      { params: Promise.resolve({ id: project.id }) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain(
      'filename="direct.zip"',
    );
    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    expect(
      await zip.files["direct.dezfil/datasets/direct.parquet"].async(
        "string",
      ),
    ).toBe("direct-bytes");
    await expect.poll(stagingResidue).toEqual([]);
  });

  it("tickets are single-use and key-checked", async () => {
    seedMap("m-1", "Solo", at(1));
    const project = createProject(testAccountScope(), {
      name: "Shelf",
      members: { addMaps: ["m-1"] },
    });
    const prepared = await post(project.id, { maps: ["m-1"], file: "solo" });
    const grant = (await prepared.json()) as { ticket: string; key: string };

    const wrongKey = await redeem(project.id, grant.ticket, "nope");
    expect(wrongKey.status).toBe(410);

    const first = await redeem(project.id, grant.ticket, grant.key);
    expect(first.status).toBe(200);
    await first.arrayBuffer();

    const second = await redeem(project.id, grant.ticket, grant.key);
    expect(second.status).toBe(410);
    await expect.poll(stagingResidue).toEqual([]);
  });
});

/** A real artifact through the app's own ingest road (a fake-bytes
 * parquet cannot be converted). */
async function ingestCsv(name: string, csv: string): Promise<DataTable> {
  const src = path.join(dir, `${name}.csv`);
  await writeFile(src, csv);
  return ingestFile(testAccountScope(), src, `${name}.csv`);
}

const tmpResidue = async () =>
  readdir(path.join(data, "tmp")).catch(() => [] as string[]);

describe("the dataset format", () => {
  it("GeoJSON writes spatial datasets as GeoJSON and a dataset without geometry as CSV; the manifest names each effective format under version 1", async () => {
    const stations = await ingestCsv(
      "stations",
      "name,lon,lat\nalexanderplatz,13.41,52.52\nzoo,13.33,52.51\n",
    );
    const readings = await ingestCsv("readings", "sensor,value\na,1\nb,2\n");
    expect(stations.geometryColumn).not.toBeNull();
    expect(readings.geometryColumn).toBeNull();
    const project = createProject(testAccountScope(), { name: "Kinds" });
    const { fileTable } = await import("@/lib/metadata/projects");
    fileTable(stations.id, project.id);
    fileTable(readings.id, project.id);

    const response = await post(project.id, {
      datasets: [stations.id, readings.id],
      file: "kinds",
      datasetFormat: "geojson",
      prepare: false,
    });
    expect(response.status).toBe(200);
    const zip = await JSZip.loadAsync(
      Buffer.from(await response.arrayBuffer()),
    );
    const entries = Object.keys(zip.files)
      .filter((f) => !f.endsWith("/"))
      .sort();
    expect(entries).toEqual([
      "kinds.dezfil/datasets/readings.csv",
      "kinds.dezfil/datasets/stations.geojson",
      "kinds.dezfil/project.json",
    ]);
    const manifest = JSON.parse(
      await zip.file("kinds.dezfil/project.json")!.async("string"),
    ) as {
      formatVersion: number;
      contents: { datasets: { name: string; file: string; format: string }[] };
    };
    expect(manifest.formatVersion).toBe(1);
    // The manifest keeps the canonical listing order (newest first);
    // the facts are compared by name.
    const byName = new Map(manifest.contents.datasets.map((d) => [d.name, d]));
    expect(byName.get("stations")).toEqual(
      expect.objectContaining({
        id: stations.id,
        file: "datasets/stations.geojson",
        format: "geojson",
      }),
    );
    expect(byName.get("readings")).toEqual(
      expect.objectContaining({
        id: readings.id,
        file: "datasets/readings.csv",
        format: "csv",
      }),
    );
    const geojson = JSON.parse(
      await zip
        .file("kinds.dezfil/datasets/stations.geojson")!
        .async("string"),
    ) as { type: string; features: { geometry: { type: string } }[] };
    expect(geojson.type).toBe("FeatureCollection");
    expect(geojson.features).toHaveLength(2);
    expect(geojson.features[0].geometry.type).toBe("Point");
    const csv = await zip
      .file("kinds.dezfil/datasets/readings.csv")!
      .async("string");
    expect(csv.split("\n")[0]).toBe("sensor,value");
    // Every conversion left with the assembly; no staging residue.
    expect(await tmpResidue()).toEqual([]);
    expect(await stagingResidue()).toEqual([]);
  });

  it("CSV carries geometry as WKT text; omitted or explicit GeoParquet keeps today's entry paths and bytes", async () => {
    const stations = await ingestCsv(
      "stations",
      "name,lon,lat\nalexanderplatz,13.41,52.52\n",
    );
    const project = createProject(testAccountScope(), { name: "Kinds" });
    const { fileTable } = await import("@/lib/metadata/projects");
    fileTable(stations.id, project.id);
    const stored = sha256(
      await (
        await import("node:fs/promises")
      ).readFile(path.join(data, stations.file)),
    );

    const csvResponse = await post(project.id, {
      datasets: [stations.id],
      file: "kinds",
      datasetFormat: "csv",
      prepare: false,
    });
    expect(csvResponse.status).toBe(200);
    const csvZip = await JSZip.loadAsync(
      Buffer.from(await csvResponse.arrayBuffer()),
    );
    const csv = await csvZip
      .file("kinds.dezfil/datasets/stations.csv")!
      .async("string");
    expect(csv).toMatch(/POINT \(13\.41 52\.52\)/);

    for (const body of [{}, { datasetFormat: "geoparquet" }]) {
      const response = await post(project.id, {
        datasets: [stations.id],
        file: "kinds",
        prepare: false,
        ...body,
      });
      expect(response.status).toBe(200);
      const zip = await JSZip.loadAsync(
        Buffer.from(await response.arrayBuffer()),
      );
      const entry = zip.file("kinds.dezfil/datasets/stations.parquet");
      expect(entry, JSON.stringify(body)).not.toBeNull();
      expect(sha256(await entry!.async("nodebuffer"))).toBe(stored);
      const manifest = JSON.parse(
        await zip.file("kinds.dezfil/project.json")!.async("string"),
      ) as { contents: { datasets: { format: string }[] } };
      expect(manifest.contents.datasets[0].format).toBe("geoparquet");
    }
    expect(await tmpResidue()).toEqual([]);
  });

  it("refuses an unknown format; a failed conversion is the existing refusal with no download and no residue", async () => {
    const project = createProject(testAccountScope(), { name: "Kinds" });
    const fake = await seedDataset(
      "t-fake",
      "fake",
      Buffer.from("not a parquet file"),
    );
    const { fileTable } = await import("@/lib/metadata/projects");
    fileTable(fake.id, project.id);
    const bad = await post(project.id, {
      datasets: [fake.id],
      file: "kinds",
      datasetFormat: "shapefile",
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe(
      "invalid_request",
    );
    // The fake bytes cannot be converted: the conversion fails, the
    // archive is refused, nothing is staged and nothing is left in tmp.
    const failed = await post(project.id, {
      datasets: [fake.id],
      file: "kinds",
      datasetFormat: "geojson",
    });
    expect(failed.status).toBe(500);
    expect(
      ((await failed.json()) as { error: { code: string } }).error.code,
    ).toBe("export_failed");
    expect(await stagingResidue()).toEqual([]);
    expect(await tmpResidue()).toEqual([]);
  });
});
