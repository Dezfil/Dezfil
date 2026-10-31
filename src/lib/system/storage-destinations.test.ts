import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { importFromUrl } from "@/lib/ingest/remote";
import { closeMetadataDb } from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { ingestSource } from "@/lib/ingest/gdal-formats";
import { exportTable } from "@/lib/table-service";
import { exportLayerResult, exportQueryResult } from "@/lib/export/layer-export";
import { assembleProjectExport } from "@/lib/export/project-export";
import { createProject } from "@/lib/metadata/owned-projects";
import { POINTS_VIZ } from "@/lib/viz";
import { createMap } from "@/lib/map-service";
import { documentFacts } from "@/lib/metadata/document-facts";
import { createSketch } from "@/lib/sketch/store";
import { copyDatasetFile } from "@/lib/templates/copy-artifacts";
import { saveThumbnail, readThumbnail } from "@/lib/map-thumbnails";
import { errorResponse } from "@/lib/api/errors";
import { ownedFileRecords } from "@/lib/ingest/file-ownership";

const faults = vi.hoisted(() => ({ stream: false, picture: false }));
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, createWriteStream: (...args: Parameters<typeof actual.createWriteStream>) => {
    if (!faults.stream) return actual.createWriteStream(...args);
    return new Writable({ write(chunk, _encoding, done) {
      actual.writeFileSync(args[0], chunk);
      done(Object.assign(new Error("destination refused"), { code: "ENOSPC" }));
    } });
  } };
});
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
    if (faults.picture && String(args[0]).includes("/thumbnails/")) {
      await actual.writeFile(args[0], "partial");
      throw Object.assign(new Error("destination refused"), { code: "ENOSPC" });
    }
    return actual.writeFile(...args);
  } };
});

const root = process.env.DEZFIL_DATA_DIR!;
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(root, "destinations-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
  closeMetadataDb();
});
afterEach(async () => {
  faults.stream = faults.picture = false;
  vi.restoreAllMocks(); closeMetadataDb(); vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});
const files = async (folder: string) => (await readdir(path.join(dir, folder)).catch(() => [])).sort();
async function exhausted(work: Promise<unknown>) {
  const failure = await work.then(() => { throw new Error("write unexpectedly succeeded"); }, error => error);
  const response = errorResponse(failure);
  expect(response.status).toBe(507);
  expect((await response.json()).error.code).toBe("storage_exhausted");
}
/** Refuse the destination COPY after creating a real partial file. Every
 * other statement still goes to the native engine. */
function refuseCopy() {
  for (const method of ["run", "runAndReadAll"] as const) {
    const original = DuckDBConnection.prototype[method];
    vi.spyOn(DuckDBConnection.prototype, method).mockImplementation(async function(this: DuckDBConnection, ...args: Parameters<typeof original>) {
      const target = /\bCOPY\b[\s\S]*\bTO\s+'([^']+)'/i.exec(args[0]);
      if (target) {
        writeFileSync(target[1], "partial");
        throw new Error(`IO Error: Could not write file "${target[1]}": No space left on device`);
      }
      return Reflect.apply(original, this, args);
    } as typeof original);
  }
}

it.each(["csv", "kml"])("removes a refused %s conversion and its ownership", async format => {
  const scope = testAccountScope();
  const source = path.join(dir, `input.${format}`);
  await writeFile(source, format === "csv" ? "x,y\n1,2\n" : '<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><Point><coordinates>1,2</coordinates></Point></Placemark></Document></kml>');
  refuseCopy();
  await exhausted(ingestSource(scope, source, `input.${format}`));
  expect(await files("tables")).toEqual([]);
  expect(ownedFileRecords()).toEqual([]);
});

it("keeps the dataset through failed download conversion and query export", async () => {
  const scope = testAccountScope();
  const source = path.join(dir, "input.csv");
  await writeFile(source, "x,y\n1,2\n");
  const { tables: [table] } = await ingestSource(scope, source, "input.csv");
  const previous = await readFile(path.join(dir, table.file));
  refuseCopy();
  await exhausted(exportTable(scope, table.name, "csv"));
  await exhausted(exportQueryResult(scope, "SELECT 1 AS n", "csv"));
  await exhausted(exportLayerResult(scope, { name: "Points", sql: "SELECT ST_Point(1, 2) AS geom", filters: [], viz: POINTS_VIZ }, "csv"));
  expect(await readFile(path.join(dir, table.file))).toEqual(previous);
  expect(await files("tmp")).toEqual([]);
  expect(await files("tiles/scratch")).toEqual([]);
});

it("removes a partial project archive", async () => {
  const scope = testAccountScope();
  const project = createProject(scope, { name: "Export" });
  const map = createMap(scope, "Map", project.id);
  faults.stream = true;
  await exhausted(assembleProjectExport(scope, project.id, { maps: [map.id], recipes: [], tables: [], file: "export" }));
  expect(await files("exports")).toEqual([]);
  expect(ownedFileRecords()).toEqual([]);
});

it("removes the sketch candidate and leaves the map saved", async () => {
  const scope = testAccountScope();
  const map = createMap(scope, "Saved map");
  refuseCopy();
  await exhausted(createSketch(scope, map.id, { kind: "point", geometry: { type: "Point", coordinates: [1, 2] } }, { expectedRevision: documentFacts({ kind: "map", id: map.id }).editRevision }));
  expect(await files("tables")).toEqual([]);
  expect(ownedFileRecords()).toEqual([]);
});

it("cleans a partial template copy without touching its source", async () => {
  await mkdir(path.join(dir, "source"));
  await writeFile(path.join(dir, "source", "table.parquet"), "original");
  faults.stream = true;
  await exhausted(copyDatasetFile("owner", path.join(dir, "source"), "table.parquet", "unused"));
  expect(await files("tables")).toEqual([]);
  expect(ownedFileRecords()).toEqual([]);
  expect(await readFile(path.join(dir, "source", "table.parquet"), "utf8")).toBe("original");
});

it("names a remote destination failure and removes the received partial", async () => {
  const scope = testAccountScope();
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "127.0.0.1");
  const server = createServer((_request, response) => response.end("x,y\n1,2\n"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    faults.stream = true;
    await exhausted(importFromUrl(scope, `http://127.0.0.1:${(server.address() as AddressInfo).port}/data.csv`));
    expect(await files("tmp")).toEqual([]);
    expect(ownedFileRecords()).toEqual([]);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

it("keeps a map's previous picture after a partial destination write", async () => {
  const scope = testAccountScope();
  const map = createMap(scope, "Pictured map");
  await saveThumbnail(scope, map.id, Buffer.from("previous"));
  faults.picture = true;
  await exhausted(saveThumbnail(scope, map.id, Buffer.from("replacement")));
  expect((await readThumbnail(scope, map.id))?.toString()).toBe("previous");
  expect((await files("thumbnails")).some(file => file.endsWith(".tmp"))).toBe(false);
});
