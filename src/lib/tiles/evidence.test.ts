import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { invalidateTilesForTable } from "@/lib/ingest/refresh";
import { updateTableData, type DataTable } from "@/lib/metadata/tables";
import { getTileRecord } from "@/lib/metadata/tiles";
import { createMap } from "@/lib/map-service";
import { createLayer, renderLayer } from "@/lib/layer-service";
import type { Layer } from "@/lib/metadata/maps";
import type { AccountScope } from "@/lib/auth/scope";
import { testAccountScope } from "@/lib/test-support/accounts";
import { shareProject } from "@/lib/test-support/sharing";
import { removeTable } from "@/lib/table-service";
import { privateTileAccess } from "./access";
import { resetTileBuilds, tileBuildsSettled } from "./build";
import { tileArchivePath } from "./paths";

/**
 * A tile archive records what its build drew, by identity. Ada and Bob each
 * own a `roads`; Bob files his in project P, where Ada is a viewer. Ada's map
 * draws her own `roads`, Bob's `bob.roads`, and her `roads` behind a
 * catalogue read. Each archive's evidence names exactly the datasets its
 * export bound (the catalogue read: everything Ada reaches), and a dataset's
 * refresh reaches the layers whose tiles drew it, whoever owns the map,
 * never a layer that read a same-named dataset of someone else.
 */
const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
let scopes: Record<string, AccountScope>;
let tables: Record<string, DataTable>;
let layers: Record<"mine" | "theirs" | "listing", Layer>;

beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "tile-evidence-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  vi.stubEnv("DEZFIL_RENDER_CAP_FEATURES", "1");
  closeMetadataDb(); resetQueryInstance(); resetTileBuilds();
  scopes = Object.fromEntries(["ada", "bob"].map((id) => [id, testAccountScope(undefined, id)]));
  tables = {};
  for (const owner of ["ada", "bob"]) {
    const file = path.join(directory, `${owner}-roads.csv`);
    await writeFile(file, `sentinel,lon,lat\n${owner} a,1,2\n${owner} b,3,4\n${owner} c,5,6\n`);
    tables[owner] = await ingestFile(scopes[owner], file, "roads.csv");
  }
  shareProject("bob", "P", [["ada", "viewer"]], [tables.bob.id]);
  const map = createMap(scopes.ada, "Survey");
  layers = {
    mine: await createLayer(scopes.ada, map.id, { name: "Mine", sql: "SELECT * FROM roads" }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision }),
    theirs: await createLayer(scopes.ada, map.id, { name: "Theirs", sql: "SELECT * FROM bob.roads" }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision }),
    listing: await createLayer(scopes.ada, map.id, {
      name: "Listing",
      sql: "SELECT r.* FROM roads r WHERE EXISTS (SELECT view_name FROM duckdb_views())",
    }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision }),
  };
});
afterEach(async () => {
  await tileBuildsSettled();
  closeMetadataDb(); resetQueryInstance(); resetTileBuilds(); vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

async function render(layer: Layer, scope: AccountScope = scopes.ada) {
  return renderLayer(scope, layer, undefined, { tileAccess: privateTileAccess(scope, layer.id) });
}
async function buildAll() {
  for (const layer of Object.values(layers)) { const r = await render(layer); expect(r.mode, JSON.stringify(r).slice(0, 400)).toBe("tiled"); }
  await tileBuildsSettled();
  for (const layer of Object.values(layers)) expect((await render(layer)).tiles?.state).toBe("ready");
}
/** The evidence on the volume, exactly as a build wrote it. */
async function evidence(layer: Layer) {
  const file = path.join(directory, "artifact-inputs", "tiles", `${layer.id}.json`);
  return JSON.parse(await readFile(file, "utf8")) as {
    fingerprint: string; builtAt: string; inputs: { catalogue: boolean; datasets: { id: string; file: string }[] };
  };
}
const ids = (entry: Awaited<ReturnType<typeof evidence>>) => entry.inputs.datasets.map((input) => input.id).sort();

describe("tile archives record what they drew", () => {
  it("names the datasets each build bound, by owner, and the whole reach behind a catalogue read", async () => {
    await buildAll();
    const mine = await evidence(layers.mine);
    expect(mine.inputs).toEqual({ catalogue: false, datasets: [{ id: tables.ada.id, file: tables.ada.file }] });
    expect(ids(await evidence(layers.theirs))).toEqual([tables.bob.id]);
    const listing = await evidence(layers.listing);
    expect(listing.inputs.catalogue).toBe(true);
    expect(ids(listing)).toEqual([tables.ada.id, tables.bob.id].sort());
    // The evidence names the record that makes its archive authoritative.
    const record = getTileRecord(layers.mine.id)!;
    expect([mine.fingerprint, mine.builtAt]).toEqual([record.fingerprint, record.builtAt]);
  });

  it("invalidates by identity: a refresh reaches the layers that drew the dataset, whoever owns the map", async () => {
    await buildAll();
    // Bob's dataset feeds Ada's `bob.roads` layer and her catalogue read.
    expect(invalidateTilesForTable(scopes.bob, "roads")).toBe(2);
    expect(getTileRecord(layers.theirs.id)).toBeNull();
    expect(getTileRecord(layers.listing.id)).toBeNull();
    expect(getTileRecord(layers.mine.id)?.state).toBe("ready");
    await buildAll();
    // Ada's own `roads` never reaches the layer that read Bob's.
    expect(invalidateTilesForTable(scopes.ada, "roads")).toBe(2);
    expect(getTileRecord(layers.mine.id)).toBeNull();
    expect(getTileRecord(layers.theirs.id)?.state).toBe("ready");
  });

  it("decides freshness by the recorded identity: Bob's new artifact stales only what drew his dataset", async () => {
    await buildAll();
    // The refresh's prompt invalidation is lost: only Bob's artifact moves.
    const moved = "tables/bob-relocated.parquet";
    await copyFile(path.join(directory, tables.bob.file), path.join(directory, moved));
    updateTableData({ name: "roads", id: tables.bob.id }, {
      file: moved, geometryColumn: tables.bob.geometryColumn, geometryType: tables.bob.geometryType,
      crsAssumed: tables.bob.crsAssumed, headerSuspect: false, rowCount: tables.bob.rowCount, importedAt: new Date().toISOString(),
    });
    expect((await render(layers.theirs)).tiles?.state).toBe("building");
    expect((await render(layers.listing)).tiles?.state).toBe("building");
    expect((await render(layers.mine)).tiles?.state).toBe("ready");
    await tileBuildsSettled();
    expect((await evidence(layers.theirs)).inputs.datasets).toEqual([{ id: tables.bob.id, file: moved }]);
  });
});

describe("archives built before archives recorded their inputs", () => {
  it("are reclaimed when a dataset their owner's SQL names is deleted, on that owner's maps alone", async () => {
    // Bob's own map draws his `roads` by plain name.
    const depot = createMap(scopes.bob, "Depot");
    const bobs = await createLayer(scopes.bob, depot.id, { name: "His", sql: "SELECT * FROM roads" }, { expectedRevision: readEditRevision({ kind: "map", id: depot.id })?.editRevision });
    await buildAll();
    expect((await render(bobs, scopes.bob)).mode).toBe("tiled");
    await tileBuildsSettled();
    expect((await render(bobs, scopes.bob)).tiles?.state).toBe("ready");
    // As an archive of before: a ready record and its archive, no evidence.
    for (const layer of [layers.mine, bobs]) await rm(path.join(directory, "artifact-inputs", "tiles", `${layer.id}.json`));
    await removeTable(scopes.ada, "roads");
    expect(getTileRecord(layers.mine.id)).toBeNull();
    expect(existsSync(tileArchivePath(layers.mine.id))).toBe(false);
    // Bob's same-named dataset and the archives that drew it stay.
    expect(getTileRecord(bobs.id)?.state).toBe("ready");
    expect(existsSync(tileArchivePath(bobs.id))).toBe(true);
    expect(getTileRecord(layers.theirs.id)?.state).toBe("ready");
  });
});
