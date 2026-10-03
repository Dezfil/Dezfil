import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { getLayer as readEditLayer } from "@/lib/metadata/maps";
import { privateTileAccess } from "@/lib/tiles/access";
import { testAccountScope } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { createMap } from "@/lib/map-service";
import {
  createLayer,
  renderLayer,
  updateLayer,
  type LayerRenderGeometryType,
} from "@/lib/layer-service";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
});

afterEach(async () => {
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

async function geometryTypeFor(sql: string): Promise<LayerRenderGeometryType> {
  const map = createMap(testAccountScope(), "geometry");
  const layer = await createLayer(testAccountScope(), map.id, { name: "geometry", sql }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
  const result = await renderLayer(testAccountScope(), layer, undefined, { tileAccess: privateTileAccess(testAccountScope(), (layer).id) });
  expect(result.ok).toBe(true);
  return result.geometryType ?? null;
}

describe("render geometry metadata", () => {
  it("canonicalizes simple and multi variants into one family", async () => {
    await expect(
      geometryTypeFor(`SELECT ST_GeomFromText(wkt) AS geometry
        FROM (VALUES ('POINT (0 0)'), ('MULTIPOINT ((1 1), (2 2))')) AS v(wkt)`),
    ).resolves.toBe("POINT");
    await expect(
      geometryTypeFor(`SELECT ST_GeomFromText(wkt) AS geometry
        FROM (VALUES ('LINESTRING (0 0, 1 1)'),
                     ('MULTILINESTRING ((1 1, 2 2))')) AS v(wkt)`),
    ).resolves.toBe("LINESTRING");
    await expect(
      geometryTypeFor(`SELECT ST_GeomFromText(wkt) AS geometry
        FROM (VALUES ('POLYGON ((0 0, 1 0, 1 1, 0 0))'),
                     ('MULTIPOLYGON (((1 1, 2 1, 2 2, 1 1)))')) AS v(wkt)`),
    ).resolves.toBe("POLYGON");
  });

  it("reports the effective mixed, filtered, and empty result", async () => {
    const map = createMap(testAccountScope(), "effective geometry");
    const layer = await createLayer(testAccountScope(), map.id, {
      name: "mixed",
      sql: `SELECT kind, ST_GeomFromText(wkt) AS geometry
        FROM (VALUES ('point', 'POINT (0 0)'),
                     ('line', 'LINESTRING (0 0, 1 1)')) AS v(kind, wkt)`,
    }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });

    expect((await renderLayer(testAccountScope(), layer, undefined, { tileAccess: privateTileAccess(testAccountScope(), (layer).id) })).geometryType).toBe("MIXED");

    const points = await updateLayer(testAccountScope(), layer.id, {
      filters: [{ field: "kind", kind: "values", values: ["point"] }],
    }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    expect((await renderLayer(testAccountScope(), points, undefined, { tileAccess: privateTileAccess(testAccountScope(), (points).id) })).geometryType).toBe("POINT");

    const empty = await updateLayer(testAccountScope(), layer.id, {
      filters: [{ field: "kind", kind: "values", values: [] }],
    }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    expect((await renderLayer(testAccountScope(), empty, undefined, { tileAccess: privateTileAccess(testAccountScope(), (empty).id) })).geometryType).toBeNull();
  });
});
