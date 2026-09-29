import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { getTableByName, updateTableData } from "@/lib/metadata/tables";
import { getTileRecord, upsertTileRecord } from "@/lib/metadata/tiles";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { invalidateTilesForTable } from "@/lib/ingest/refresh";
import { createMap, removeMap, undoChange } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import { removeLayer } from "@/lib/layer-removal";
import {
  ensureTiles,
  removeTileArtifacts,
  resetTileBuilds,
  sweepTileArchives,
  tileBuildsSettled,
  tileFingerprint,
} from "./build";
import { tileArchivePath } from "./paths";

/**
 * Build orchestration: fingerprint freshness, background builds with an
 * atomic swap, failure states that stick per effective query, and artifact
 * lifecycle. All against the real tippecanoe.
 */

let dir: string;
let mapId: string;
let layerId: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
  resetTileBuilds();
  const src = path.join(dir, "stations.csv");
  await writeFile(
    src,
    [
      "name,category,lon,lat,riders",
      "alexanderplatz,u,13.410,52.520,900",
      "hackescher,s,13.402,52.523,700",
      "zoo,u,13.330,52.510,500",
      "sudkreuz,s,13.360,52.480,120",
    ].join("\n"),
  );
  await ingestFile(testAccountScope(), src, "stations.csv");
  // Tile records reference real layers (FK) — build against one.
  const map = createMap(testAccountScope(), "m");
  mapId = map.id;
  const layer = await createLayer(testAccountScope(), map.id, { name: "Stations", sql: SQL });
  layerId = layer.id;
});

afterEach(async () => {
  await tileBuildsSettled();
  closeMetadataDb();
  resetQueryInstance();
  resetTileBuilds();
  delete process.env.DEZFIL_DATA_DIR;
  delete process.env.DEZFIL_TIPPECANOE;
  delete process.env.DEZFIL_TEST_TILER_STARTED;
  delete process.env.DEZFIL_TEST_TILER_RELEASE;
  delete process.env.DEZFIL_TEST_TILER_LOG;
  delete process.env.DEZFIL_TILE_BUILD_TIMEOUT_S;
  await rm(dir, { recursive: true, force: true });
});

const SQL = "SELECT name, category, riders, geometry FROM stations";

function input(filters: unknown[] = []) {
  return {
    layerId,
    sql: SQL,
    filters: filters as [],
    geometryColumn: "geometry",
    columns: ["name", "category", "riders"],
    projection: "",
  };
}

function inputFor(id: string, filters: unknown[] = []) {
  return { ...input(filters), layerId: id };
}

async function gatedTiler() {
  const executable = path.join(dir, "gated-tippecanoe");
  const started = path.join(dir, "tiler-started");
  const release = path.join(dir, "tiler-release");
  const log = path.join(dir, "tiler-log");
  await writeFile(
    executable,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "tippecanoe v0.0-test" >&2; exit 0; fi
out=""
input=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then shift; out="$1"; else input="$1"; fi
  shift
done
printf '%s\\n' "$input" >> "$DEZFIL_TEST_TILER_LOG"
: > "$DEZFIL_TEST_TILER_STARTED"
while [ ! -f "$DEZFIL_TEST_TILER_RELEASE" ]; do sleep 0.01; done
printf 'PMTiles%s' "$input" > "$out"
`,
    { mode: 0o755 },
  );
  process.env.DEZFIL_TIPPECANOE = executable;
  process.env.DEZFIL_TEST_TILER_STARTED = started;
  process.env.DEZFIL_TEST_TILER_RELEASE = release;
  process.env.DEZFIL_TEST_TILER_LOG = log;
  process.env.DEZFIL_TILE_BUILD_TIMEOUT_S = "2";
  return {
    started,
    release: () => writeFile(release, "go"),
    log,
  };
}

describe("tile builds", () => {
  it("builds a PMTiles archive in the background and reports ready", async () => {
    const first = ensureTiles(input());
    expect(first.state).toBe("building");

    await tileBuildsSettled();
    const done = ensureTiles(input());
    expect(done.state).toBe("ready");
    expect(done.featureCount).toBe(4);

    const archive = tileArchivePath(layerId);
    expect(existsSync(archive)).toBe(true);
    const head = await readFile(archive);
    expect(head.subarray(0, 7).toString("latin1")).toBe("PMTiles");
  });

  it("fingerprint covers SQL, filters, referenced data identity, and the projection — nothing else", () => {
    const base = tileFingerprint(SQL, [], "");
    expect(tileFingerprint(SQL, [], "")).toBe(base); // stable
    // a projection-signature change is a data change for the archive.
    expect(tileFingerprint(SQL, [], '{"override":["name"]}')).not.toBe(base);
    expect(
      tileFingerprint(SQL, [
        { field: "riders", kind: "range", min: 400, max: null },
      ], ""),
    ).not.toBe(base);
    expect(tileFingerprint(`${SQL} LIMIT 3`, [], "")).not.toBe(base);
    // A refreshed table mints a new artifact file, and
    // the fingerprint must see it — data changes always look like changes.
    const table = getTableByName("stations")!;
    updateTableData(
      { name: "stations", id: table.id },
      {
        file: "tables/relocated.parquet",
        geometryColumn: table.geometryColumn,
        geometryType: table.geometryType,
        crsAssumed: table.crsAssumed,
        headerSuspect: false,
        rowCount: table.rowCount,
        importedAt: new Date().toISOString(),
      },
    );
    expect(tileFingerprint(SQL, [], "")).not.toBe(base);
    // A layer on an unrelated table is untouched by that identity change.
    expect(tileFingerprint("SELECT * FROM other_things", [], "")).toBe(
      tileFingerprint("SELECT * FROM other_things", [], ""),
    );
  });

  it("a ready archive is reused, not rebuilt", async () => {
    ensureTiles(input());
    await tileBuildsSettled();
    const before = getTileRecord(layerId)!.updatedAt;
    const again = ensureTiles(input());
    expect(again.state).toBe("ready");
    await tileBuildsSettled();
    expect(getTileRecord(layerId)!.updatedAt).toBe(before);
  });

  it("a filter change re-fingerprints and rebuilds with the filtered result", async () => {
    ensureTiles(input());
    await tileBuildsSettled();

    const filtered = ensureTiles(
      input([{ field: "riders", kind: "range", min: 400, max: null }]),
    );
    expect(filtered.state).toBe("building");
    await tileBuildsSettled();

    const done = ensureTiles(
      input([{ field: "riders", kind: "range", min: 400, max: null }]),
    );
    expect(done.state).toBe("ready");
    expect(done.featureCount).toBe(3);
  });

  it("a failed build sticks for that effective query and carries a message", async () => {
    process.env.DEZFIL_TIPPECANOE = "/nonexistent/tippecanoe";
    ensureTiles(input());
    await tileBuildsSettled();

    const failed = ensureTiles(input());
    expect(failed.state).toBe("failed");
    expect(failed.error).toBeTruthy();
    expect(existsSync(tileArchivePath(layerId))).toBe(false);

    // The same effective query does not retry-storm…
    expect(ensureTiles(input()).state).toBe("failed");
    // …but a changed one builds again (with the tiler back).
    delete process.env.DEZFIL_TIPPECANOE;
    const changed = ensureTiles(
      input([{ field: "riders", kind: "range", min: 0, max: null }]),
    );
    expect(changed.state).toBe("building");
    await tileBuildsSettled();
  });

  it("an interrupted build (restart) starts over", async () => {
    // A record left in 'building' with no in-process build is a dead build.
    upsertTileRecord({
      layerId,
      state: "building",
      fingerprint: tileFingerprint(SQL, [], ""),
      error: null,
      featureCount: null,
      builtAt: null,
    });
    const status = ensureTiles(input());
    expect(status.state).toBe("building");
    await tileBuildsSettled();
    expect(ensureTiles(input()).state).toBe("ready");
  });

  it("removeTileArtifacts deletes the archive and the record", async () => {
    ensureTiles(input());
    await tileBuildsSettled();
    expect(existsSync(tileArchivePath(layerId))).toBe(true);

    await removeTileArtifacts(layerId);
    expect(existsSync(tileArchivePath(layerId))).toBe(false);
    expect(getTileRecord(layerId)).toBeNull();
    closeMetadataDb();
    expect(getTileRecord(layerId)).toBeNull();
  });

  it("edits during a build converge on the newest effective query", async () => {
    ensureTiles(input());
    // While that runs, two more edits arrive; the middle one is skipped.
    ensureTiles(
      input([{ field: "riders", kind: "range", min: 100, max: null }]),
    );
    ensureTiles(
      input([{ field: "riders", kind: "range", min: 400, max: null }]),
    );
    await tileBuildsSettled();

    const done = ensureTiles(
      input([{ field: "riders", kind: "range", min: 400, max: null }]),
    );
    expect(done.state).toBe("ready");
    expect(done.featureCount).toBe(3);
  });

  it("fences a layer deletion during active preparation and keeps the queue usable", async () => {
    const gate = await gatedTiler();
    ensureTiles(input());
    await vi.waitFor(() => expect(existsSync(gate.started)).toBe(true));

    await removeLayer(testAccountScope(), layerId);
    await gate.release();
    await tileBuildsSettled();

    expect(existsSync(tileArchivePath(layerId))).toBe(false);
    expect(getTileRecord(layerId)).toBeNull();

    const unrelated = await createLayer(testAccountScope(), mapId, { name: "later", sql: SQL });
    ensureTiles(inputFor(unrelated.id));
    await tileBuildsSettled();
    expect(getTileRecord(unrelated.id)?.state).toBe("ready");
    expect(existsSync(tileArchivePath(unrelated.id))).toBe(true);
  });

  it("fences every queued and active layer when a map is deleted", async () => {
    const other = await createLayer(testAccountScope(), mapId, { name: "other", sql: SQL });
    const gate = await gatedTiler();
    ensureTiles(input());
    ensureTiles(inputFor(other.id));
    await vi.waitFor(() => expect(existsSync(gate.started)).toBe(true));

    await removeMap(testAccountScope(), mapId);
    await gate.release();
    await tileBuildsSettled();

    for (const id of [layerId, other.id]) {
      expect(existsSync(tileArchivePath(id))).toBe(false);
      expect(getTileRecord(id)).toBeNull();
    }
  });

  it("a refresh invalidation fences a build already running", async () => {
    const gate = await gatedTiler();
    ensureTiles(input());
    await vi.waitFor(() => expect(existsSync(gate.started)).toBe(true));

    // The table under the layer refreshes while the tiler is mid-run: the
    // record goes AND the attempt is fenced, so old-data tiles can never
    // register as ready under the unchanged fingerprint.
    expect(invalidateTilesForTable(testAccountScope(), "stations")).toBe(1);
    await gate.release();
    await tileBuildsSettled();

    expect(getTileRecord(layerId)).toBeNull();
    expect(existsSync(tileArchivePath(layerId))).toBe(false);

    // The next render re-decides freshness with a fresh build.
    expect(ensureTiles(input()).state).toBe("building");
    await tileBuildsSettled();
    expect(getTileRecord(layerId)?.state).toBe("ready");
    expect(existsSync(tileArchivePath(layerId))).toBe(true);
  });

  it("a data change alone re-decides freshness — a lost invalidation self-heals", async () => {
    ensureTiles(input());
    await tileBuildsSettled();
    expect(getTileRecord(layerId)?.state).toBe("ready");

    // The refresh's prompt invalidation is lost entirely: only the
    // registry's artifact identity changes, as a committed swap does.
    const table = getTableByName("stations")!;
    await copyFile(
      path.join(process.env.DEZFIL_DATA_DIR!, table.file),
      path.join(process.env.DEZFIL_DATA_DIR!, "tables/relocated.parquet"),
    );
    updateTableData(
      { name: "stations", id: table.id },
      {
        file: "tables/relocated.parquet",
        geometryColumn: table.geometryColumn,
        geometryType: table.geometryType,
        crsAssumed: table.crsAssumed,
        headerSuspect: false,
        rowCount: table.rowCount,
        importedAt: new Date().toISOString(),
      },
    );

    // The stale-ready record no longer reads as fresh; the render rebuilds.
    expect(ensureTiles(input()).state).toBe("building");
    await tileBuildsSettled();
    expect(getTileRecord(layerId)?.state).toBe("ready");
  });

  it("boot sweep removes recordless archives and keeps authoritative ones", async () => {
    ensureTiles(input());
    await tileBuildsSettled();
    expect(getTileRecord(layerId)?.state).toBe("ready");

    // A failed unlink after a delete (or a crash) leaves an archive with
    // no record — servable at its old URL, authoritative nowhere.
    await writeFile(tileArchivePath("dead-layer"), "PMTilesdead");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await sweepTileArchives()).toBe(1);
    } finally {
      warn.mockRestore();
    }
    expect(existsSync(tileArchivePath("dead-layer"))).toBe(false);
    expect(existsSync(tileArchivePath(layerId))).toBe(true);
    expect(await sweepTileArchives()).toBe(0);
  });

  it("undo restoration starts a fresh attempt instead of adopting deleted work", async () => {
    const gate = await gatedTiler();
    ensureTiles(input());
    await vi.waitFor(() => expect(existsSync(gate.started)).toBe(true));

    await removeLayer(testAccountScope(), layerId);
    await undoChange(testAccountScope(), mapId);
    expect(ensureTiles(input()).state).toBe("building");

    await gate.release();
    await tileBuildsSettled();

    expect(getTileRecord(layerId)?.state).toBe("ready");
    expect(existsSync(tileArchivePath(layerId))).toBe(true);
    const attempts = (await readFile(gate.log, "utf8")).trim().split("\n");
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts).size).toBe(2);
  });
});
