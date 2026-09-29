import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { removeTable } from "@/lib/table-service";
import { createMap, mapWithLayers, updateMap } from "@/lib/map-service";
import { computeWidgetValues } from "@/lib/widget-service";
import { publishedMessage } from "@/lib/api/error-catalogue";
import { createLayer, updateLayer } from "@/lib/layer-service";
import { publishMap, resetPublishCache } from "@/lib/publish/publish-service";
import { resetRateLimits } from "@/lib/publish/rate-limit";
import type { MapWidget } from "@/lib/widgets";
import { POST } from "./route";

/**
 * The published widget-values lane's reader gate: a selection that
 * cannot be evaluated against its widget's column refuses with the
 * documented code before evaluation — never a raw engine message in a
 * 200 batch.
 */

let dir: string;
let token: string;
let layerId: string;
let mapId: string;

const widget = (over: Partial<MapWidget>): MapWidget => ({
  id: "w",
  type: "histogram",
  layerId: "",
  title: "Card",
  field: "score",
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
  resetPublishCache();
  resetRateLimits();
  const source = path.join(dir, "points.csv");
  await writeFile(
    source,
    "id,kind,score,lon,lat\n1,a,10,1,2\n2,b,20,3,4\n3,a,30,5,6\n",
  );
  await ingestFile(testAccountScope(), source, "points.csv");
  const map = createMap(testAccountScope(), "m");
  const layer = await createLayer(testAccountScope(), map.id, {
    name: "l",
    sql: "SELECT * FROM points",
  });
  layerId = layer.id;
  mapId = map.id;
  updateMap(testAccountScope(), map.id, {
    widgets: [
      widget({ id: "wh", layerId }),
      widget({
        id: "wc",
        layerId,
        type: "category",
        title: "Kinds",
        field: "kind",
      }),
    ],
  });
  token = publishMap(testAccountScope(), map.id).token;
});

afterEach(async () => {
  closeMetadataDb();
  resetQueryInstance();
  resetPublishCache();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

async function values(selections: unknown) {
  const response = await POST(
    new Request(`http://localhost/api/published/${token}/widget-values`, {
      method: "POST",
      body: JSON.stringify({ selections }),
    }),
    { params: Promise.resolve({ token }) },
  );
  return { status: response.status, body: await response.json() };
}

describe("published widget-values reader gate", () => {
  it("valid selections still evaluate", async () => {
    const res = await values([
      { widgetId: "wh", kind: "range", min: 15, max: null },
      { widgetId: "wc", kind: "exclude", values: ["b"] },
    ]);
    expect(res.status).toBe(200);
  });

  it("a range on a histogram whose column went non-numeric refuses cleanly", async () => {
    // The stored histogram widget echoes through the SQL edit; only the
    // reader's selection meets the gate.
    await updateLayer(testAccountScope(), layerId, {
      sql: "SELECT id, kind, kind AS score, geometry FROM points",
    });
    const res = await values([
      { widgetId: "wh", kind: "range", min: 15, max: null },
    ]);
    expect(res.status).toBe(400);
    const body = res.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe("selection_incompatible");
    expect(body.error.message).toContain("numeric");
    expect(body.error.message).not.toMatch(/LINE \d|Binder|Conversion/);
  });

  it("a selection on a stranded column refuses cleanly", async () => {
    await updateLayer(testAccountScope(), layerId, {
      sql: "SELECT id, score, geometry FROM points",
    });
    const res = await values([
      { widgetId: "wc", kind: "exclude", values: ["a"] },
    ]);
    expect(res.status).toBe(400);
    const body = res.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe("selection_incompatible");
    expect(body.error.message).toContain("no longer provides");
  });

  it("a hidden widget's retained id behaves like an unknown one", async () => {
    // Hide the histogram; its stored config is an echo, so the write
    // passes — and a reader's retained selection must filter nothing.
    updateMap(testAccountScope(), mapId, {
      widgets: [
        widget({ id: "wh", layerId, visible: false }),
        widget({
          id: "wc",
          layerId,
          type: "category",
          title: "Kinds",
          field: "kind",
        }),
      ],
    });
    const res = await values([
      { widgetId: "wh", kind: "range", min: 25, max: null },
    ]);
    expect(res.status).toBe(200);
    const body = res.body as {
      layers: { layerId: string; count: number; total: number }[];
    };
    // No active selection survives, so the constrained count IS the total.
    expect(body.layers).toHaveLength(1);
    expect(body.layers[0].count).toBe(3);
    expect(body.layers[0].total).toBe(3);
  });

  it("an unresolvable layer keeps degrading per-widget, reader input or not", async () => {
    await removeTable(testAccountScope(), "points");
    const res = await values([
      { widgetId: "wc", kind: "exclude", values: ["a"] },
    ]);
    // The gate skips a layer whose schema cannot resolve; the widgets
    // report their own per-widget errors exactly as with no selections.
    expect(res.status).toBe(200);
    const body = res.body as { widgets: { id: string; error?: string }[] };
    expect(body.widgets.length).toBeGreaterThan(0);
    expect(body.widgets.every((v) => v.error)).toBe(true);
  });

  it("a coded pre-batch refusal keeps its documented authored copy", async () => {
    const malformed = await POST(
      new Request(`http://localhost/api/published/${token}/widget-values`, {
        method: "POST",
        body: "{not json",
      }),
      { params: Promise.resolve({ token }) },
    );
    expect(malformed.status).toBe(400);
    const body = (await malformed.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toBe("Expected a JSON body.");
  });

  it("failed widgets carry the catalogue sentence on the wire; the builder lane keeps the raw text", async () => {
    await removeTable(testAccountScope(), "points");
    const res = await values([]);
    expect(res.status).toBe(200);
    const body = res.body as {
      widgets: { id: string; error: string; errorCode: string }[];
    };
    expect(body.widgets.length).toBeGreaterThan(0);
    for (const w of body.widgets) {
      expect(w.error).toBe(publishedMessage(w.errorCode));
    }
    expect(JSON.stringify(body)).not.toMatch(
      /does not exist|Catalog|Binder|LINE \d/,
    );

    // The builder's own computation keeps the engine's diagnostic — the
    // authenticated-equivalent carve-out.
    const record = mapWithLayers(testAccountScope(), mapId);
    const raw = await computeWidgetValues(testAccountScope(), record, record.layers, []);
    const failed = raw.widgets.filter(
      (w): w is { id: string; error: string; errorCode: never } => "error" in w,
    );
    expect(failed.length).toBeGreaterThan(0);
    expect(
      failed.some((w) => /does not exist|Catalog/i.test(w.error)),
    ).toBe(true);
  });
});
