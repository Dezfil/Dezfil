import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { createMap } from "@/lib/map-service";
import { createLayer, updateLayer, requireLayer } from "@/lib/layer-service";
import type { MapWidget } from "@/lib/widgets";
import { PATCH } from "./route";

/**
 * Map-level column-reference validation at its route boundary: widget
 * and timeline references a request introduces or changes resolve
 * against their bound layer's result; unchanged echoes pass however
 * stale, per the contract.
 */

let dir: string;
let mapId: string;
let layerId: string;

const widget = (over: Partial<MapWidget>): MapWidget => ({
  id: "w1",
  type: "formula",
  layerId: "",
  title: "Card",
  field: null,
  agg: "count",
  aggField: null,
  unit: null,
  note: null,
  format: null,
  visible: true,
  ...over,
});

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
  const source = path.join(dir, "trips.csv");
  await writeFile(
    source,
    [
      "name,cat,val,seen,lon,lat",
      "a,A,10,2021-03-01T08:00:00,13.40,52.50",
      "b,B,20,2021-03-02T08:00:00,13.41,52.51",
      "c,C,30,2021-03-03T08:00:00,13.42,52.52",
    ].join("\n"),
  );
  await ingestFile(testAccountScope(), source, "trips.csv");
  const map = createMap(testAccountScope(), "m");
  mapId = map.id;
  const layer = await createLayer(mapId, {
    name: "Trips",
    sql: "SELECT name, cat, val, seen, geometry FROM trips",
  });
  layerId = layer.id;
});

afterEach(async () => {
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

async function patch(body: unknown) {
  const response = await PATCH(
    new Request(`http://test/api/maps/${mapId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: mapId }) },
  );
  return {
    status: response.status,
    body: (await response.json()) as {
      error?: { code: string; message: string };
      basemap?: string | null;
    },
  };
}

describe("basemap writes", () => {
  it("names every accepted choice on refusal and accepts satellite", async () => {
    const invalid = await patch({ basemap: "terrain" });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error?.code).toBe("invalid_request");
    expect(invalid.body.error?.message).toBe(
      "basemap must be one of dark, light, streets, satellite, or null for the deployment default.",
    );

    const satellite = await patch({ basemap: "satellite" });
    expect(satellite.status).toBe(200);
    expect(satellite.body.basemap).toBe("satellite");
  });
});

describe("widget writes", () => {
  it("refuses widget fields the layer's result cannot honor", async () => {
    const missing = await patch({
      widgets: [widget({ layerId, type: "category", field: "typo" })],
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error?.code).toBe("column_unavailable");
    expect(missing.body.error?.message).toContain('"typo"');

    const histogramOnText = await patch({
      widgets: [widget({ layerId, type: "histogram", field: "cat" })],
    });
    expect(histogramOnText.status).toBe(400);
    expect(histogramOnText.body.error?.code).toBe("column_unavailable");

    const avgOnText = await patch({
      widgets: [widget({ layerId, field: "cat", agg: "avg" })],
    });
    expect(avgOnText.status).toBe(400);

    const rankingOnText = await patch({
      widgets: [
        widget({
          layerId,
          type: "category",
          field: "cat",
          agg: "sum",
          aggField: "name",
        }),
      ],
    });
    expect(rankingOnText.status).toBe(400);
    expect(rankingOnText.body.error?.message).toContain("ranking field");
  });

  it("accepts valid widgets of every reading shape", async () => {
    const ok = await patch({
      widgets: [
        widget({ id: "wf", layerId, field: "val", agg: "avg" }),
        widget({
          id: "wc",
          layerId,
          type: "category",
          field: "cat",
          agg: "sum",
          aggField: "val",
        }),
        widget({ id: "wh", layerId, type: "histogram", field: "val" }),
        widget({
          id: "wn",
          type: "note",
          layerId: null,
          note: "hello",
        }),
      ],
    });
    expect(ok.status).toBe(200);
  });

  it("a stranded widget echoes through — retitles included — while a new reader of the same column refuses", async () => {
    const seeded = await patch({
      widgets: [widget({ id: "wh", layerId, type: "histogram", field: "val" })],
    });
    expect(seeded.status).toBe(200);
    await updateLayer(layerId, {
      sql: "SELECT name, cat, seen, geometry FROM trips",
    });
    const retitled = await patch({
      widgets: [
        widget({
          id: "wh",
          layerId,
          type: "histogram",
          field: "val",
          title: "Renamed",
        }),
      ],
    });
    expect(retitled.status).toBe(200);
    const fresh = await patch({
      widgets: [
        widget({
          id: "wh",
          layerId,
          type: "histogram",
          field: "val",
          title: "Renamed",
        }),
        widget({ id: "w2", layerId, type: "histogram", field: "val" }),
      ],
    });
    expect(fresh.status).toBe(400);
    expect(fresh.body.error?.code).toBe("column_unavailable");
  });
});

describe("the echo compares what a widget reads, not how", () => {
  it("avg→sum on a stranded field echoes; count→avg introduces the read and refuses", async () => {
    const seeded = await patch({
      widgets: [widget({ id: "wf", layerId, field: "val", agg: "avg" })],
    });
    expect(seeded.status).toBe(200);
    await updateLayer(layerId, {
      sql: "SELECT name, cat, seen, geometry FROM trips",
    });
    // Same field, same numeric requirement — nothing new is read.
    const summed = await patch({
      widgets: [widget({ id: "wf", layerId, field: "val", agg: "sum" })],
    });
    expect(summed.status).toBe(200);
    // count reads nothing; moving to avg introduces the field read.
    const counted = await patch({
      widgets: [widget({ id: "wf", layerId, field: null, agg: "count" })],
    });
    expect(counted.status).toBe(200);
    const reintroduced = await patch({
      widgets: [widget({ id: "wf", layerId, field: "val", agg: "avg" })],
    });
    expect(reintroduced.status).toBe(400);
    expect(reintroduced.body.error?.code).toBe("column_unavailable");
  });
});

describe("timeline writes", () => {
  it("a timeline field must be a time column of its layer's result", async () => {
    await updateLayer(layerId, {
      filters: [{ field: "seen", kind: "timerange", min: null, max: null }],
    });
    const ok = await patch({ timeline: { layerId, field: "seen" } });
    expect(ok.status).toBe(200);
    // Strand the filter's column: the SQL edit and the filter echo stay
    // legal, but re-docking the timeline on the stranded field is a new
    // reference against a schema that no longer provides it.
    await updateLayer(layerId, {
      sql: "SELECT name, cat, val, geometry FROM trips",
    });
    await patch({ timeline: null });
    expect(requireLayer(layerId).filters).toHaveLength(1);
    const redock = await patch({ timeline: { layerId, field: "seen" } });
    expect(redock.status).toBe(400);
    expect(redock.body.error?.code).toBe("column_unavailable");
  });

  it("an unchanged docked timeline echoes through a widgets write", async () => {
    await updateLayer(layerId, {
      filters: [{ field: "seen", kind: "timerange", min: null, max: null }],
    });
    await patch({ timeline: { layerId, field: "seen" } });
    await updateLayer(layerId, {
      sql: "SELECT name, cat, val, geometry FROM trips",
    });
    // Re-sending the identical dock alongside other fields is an echo.
    const echoed = await patch({
      timeline: { layerId, field: "seen" },
      widgets: [],
    });
    expect(echoed.status).toBe(200);
  });
});
