import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { getLayer as readEditLayer } from "@/lib/metadata/maps";
import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { ApiError } from "@/lib/api/errors";
import { testAccountScope } from "@/lib/test-support/accounts";
import { createMap } from "@/lib/map-service";
import { defaultStyle } from "@/lib/style/defaults";
import type { LayerStyle } from "@/lib/style/style";
import { createLayer, updateLayer } from "@/lib/layer-service";

/**
 * The order a layer write's refusals come in: the layer (or, for a
 * create, the map) under the acting scope first, then the SQL the request
 * introduces, then the style, then the column references, and nothing
 * reaches the engine past the first refusal. Engine work is replaced so
 * each stage is observable; any other query fails the test.
 */

const effects = vi.hoisted(() => ({
  query: vi.fn(async () => {
    throw new Error("Unexpected engine query");
  }),
  geometry: vi.fn(async () => ({ geometryColumn: "geom", geometryType: "POINT" as string | null })),
  fields: vi.fn(async () => ({ styling: [], filterable: [], geometryColumns: ["geom"] })),
}));
vi.mock("@/lib/query/bounded", async (original) => ({
  ...(await original<object>()),
  boundedEvaluation: effects.query,
}));
vi.mock("@/lib/layer-geometry", () => ({ inspectLayerGeometry: effects.geometry }));
vi.mock("@/lib/layer-fields", async (original) => ({
  ...(await original<object>()),
  fieldsForWrite: effects.fields,
}));

const STORED_SQL = "SELECT 1 AS depth";
const BAD_STYLE = { ...defaultStyle(null), opacity: 5 } as LayerStyle;
const SQL_REFUSAL = new ApiError("invalid_request", "The SQL was refused here.", 400);

let db: Database;
let mapId: string;
const layerId = "layer-alice";

beforeEach(() => {
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  mapId = createMap(testAccountScope(db, "alice"), "Harbour").id;
  testAccountScope(db, "bob");
  db.prepare(`INSERT INTO layers (id, map_id, name, sql, style, ordinal, created_at, updated_at)
    VALUES (?, ?, 'Depths', ?, ?, 0, 'time', 'time')`).run(layerId, mapId, STORED_SQL, JSON.stringify(defaultStyle(null)));
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

const alice = () => testAccountScope(db, "alice");
const bob = () => testAccountScope(db, "bob");

describe("layer update admission order", () => {
  it("refuses a layer outside the acting scope before any SQL is inspected", async () => {
    await expect(
      updateLayer(bob(), layerId, { sql: "SELECT 2", style: BAD_STYLE, tooltip: ["nope"] }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layerId)?.mapId ?? "missing") })?.editRevision }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(effects.geometry).not.toHaveBeenCalled();
    expect(effects.fields).not.toHaveBeenCalled();
  });

  it("inspects changed SQL before it validates the style", async () => {
    effects.geometry.mockRejectedValueOnce(SQL_REFUSAL);
    await expect(
      updateLayer(alice(), layerId, { sql: "SELECT 2", style: BAD_STYLE, tooltip: ["nope"] }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layerId)?.mapId ?? "missing") })?.editRevision }),
    ).rejects.toBe(SQL_REFUSAL);
    expect(effects.fields).not.toHaveBeenCalled();
  });

  it("leaves SQL that did not change uninspected and refuses the style by its problem", async () => {
    await expect(
      updateLayer(alice(), layerId, { sql: STORED_SQL, style: BAD_STYLE, tooltip: ["nope"] }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layerId)?.mapId ?? "missing") })?.editRevision }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: "The style is not valid: opacity must be between 0 and 1.",
    });
    expect(effects.geometry).not.toHaveBeenCalled();
    expect(effects.fields).not.toHaveBeenCalled();
  });

  it("resolves the references a request introduces last", async () => {
    await expect(updateLayer(alice(), layerId, { tooltip: ["nope"] }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layerId)?.mapId ?? "missing") })?.editRevision })).rejects.toMatchObject({
      code: "column_unavailable",
      message: 'The tooltip references column "nope", which the layer\'s result does not provide.',
    });
    expect(effects.fields).toHaveBeenCalledTimes(1);
  });
});

describe("layer create admission order", () => {
  it("refuses a map outside the acting scope before any SQL is inspected", async () => {
    await expect(
      createLayer(bob(), mapId, { name: "Mine", sql: "SELECT 2", style: BAD_STYLE }, { expectedRevision: readEditRevision({ kind: "map", id: mapId })?.editRevision }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(effects.geometry).not.toHaveBeenCalled();
  });

  it("inspects the SQL before it validates the style", async () => {
    effects.geometry.mockRejectedValueOnce(SQL_REFUSAL);
    await expect(
      createLayer(alice(), mapId, { name: "Mine", sql: "SELECT 2", style: BAD_STYLE }, { expectedRevision: readEditRevision({ kind: "map", id: mapId })?.editRevision }),
    ).rejects.toBe(SQL_REFUSAL);
  });

  it("refuses an invalid style by its problem before resolving its references", async () => {
    await expect(
      createLayer(alice(), mapId, { name: "Mine", sql: "SELECT 2", style: BAD_STYLE }, { expectedRevision: readEditRevision({ kind: "map", id: mapId })?.editRevision }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: "The style is not valid: opacity must be between 0 and 1.",
    });
    expect(effects.geometry).toHaveBeenCalledTimes(1);
    expect(effects.fields).not.toHaveBeenCalled();
  });
});
