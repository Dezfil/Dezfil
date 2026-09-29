import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { createMap, updateMap } from "@/lib/map-service";
import {
  createLayer,
  updateLayer,
  layerFields,
  layerFieldStats,
  sliderPreviewData,
  renderLayer,
} from "@/lib/layer-service";
import { classifyFill, computeSizeScale } from "@/lib/style/classify";
import {
  renderLayerWithSelections,
  computeWidgetValues,
} from "@/lib/widget-service";
import {
  publishMap,
  getPublishedView,
  resetPublishCache,
} from "@/lib/publish/publish-service";
import { registerTableViews } from "@/lib/query/views";
import { executeQuery } from "@/lib/query/execute";
import { EvaluationCancelled } from "@/lib/query/bounded";
import { exportLayerResult } from "@/lib/export/layer-export";
import { POINTS_VIZ } from "@/lib/viz";
import { POST as publishedRenderRoute } from "@/app/api/published/[token]/render/[layerId]/route";
import { POST as publishedWidgetValuesRoute } from "@/app/api/published/[token]/widget-values/route";

vi.mock("@/lib/query/views", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/query/views")>();
  return { registerTableViews: vi.fn(real.registerTableViews) };
});

/**
 * The lane matrix: every consumer of user SQL fails with the documented
 * coded timeout error. Engine-heavy lanes are exercised with
 * genuinely slow SQL under a fractional-second timeout; lanes whose own
 * statements cannot be slowed (planning-only DESCRIBE) are exercised
 * through a stuck preparation, which the same budget covers.
 *
 * The recipes exploit what the optimizer can and cannot shortcut: a
 * geometry column from a tiny table survives type inspection instantly,
 * while per-row arithmetic in a value or predicate forces a real scan.
 */

/** Slow for value scans (stats-shaped lanes); near-instant to inspect. */
const SLOW_VALUES = `SELECT s.geometry AS geometry, (a.range * b.range) % 7 AS v
  FROM stations s, range(10000) a, range(10000) b`;

/** Slow for inspection and render summaries too — the per-row predicate
 * defeats the cross-join shortcuts. */
const SLOW_EVERYWHERE = `SELECT s.geometry AS geometry, (a.range * b.range) % 7 AS v
  FROM stations s, range(10000) a, range(10000) b
  WHERE (a.range * b.range) % 9 < 9`;

const FAST = "SELECT name, riders, geometry FROM stations";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
  resetPublishCache();
  vi.mocked(registerTableViews).mockClear();
  const src = path.join(dir, "stations.csv");
  await writeFile(
    src,
    [
      "name,riders,lon,lat",
      "alexanderplatz,900,13.410,52.520",
      "zoo,500,13.330,52.510",
      "sudkreuz,120,13.360,52.480",
    ].join("\n"),
  );
  await ingestFile(testAccountScope(), src, "stations.csv");
});

afterEach(async () => {
  closeMetadataDb();
  resetQueryInstance();
  resetPublishCache();
  delete process.env.DEZFIL_DATA_DIR;
  delete process.env.DEZFIL_QUERY_TIMEOUT_S;
  await rm(dir, { recursive: true, force: true });
});

function timeoutNow() {
  process.env.DEZFIL_QUERY_TIMEOUT_S = "0.1";
}

describe("query bounds — layer admission lanes", () => {
  it("layer creation times out with the documented error", async () => {
    const map = createMap(testAccountScope(), "m");
    timeoutNow();
    await expect(
      createLayer(testAccountScope(), map.id, { name: "slow", sql: SLOW_EVERYWHERE }),
    ).rejects.toMatchObject({ code: "query_timeout", status: 408 });
  }, 30_000);

  it("a SQL edit times out the same way", async () => {
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(testAccountScope(), map.id, { name: "fast", sql: FAST });
    timeoutNow();
    await expect(
      updateLayer(testAccountScope(), layer.id, { sql: SLOW_EVERYWHERE }),
    ).rejects.toMatchObject({ code: "query_timeout", status: 408 });
  }, 30_000);

  it("the fields lane is bounded through preparation", async () => {
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(testAccountScope(), map.id, { name: "fast", sql: FAST });
    timeoutNow();
    vi.mocked(registerTableViews).mockImplementationOnce(
      () => new Promise<void>(() => {}),
    );
    await expect(layerFields(layer)).rejects.toMatchObject({
      code: "query_timeout",
    });
  }, 30_000);
});

describe("query bounds — stats and styling lanes", () => {
  it("field stats time out with the documented error", async () => {
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(testAccountScope(), map.id, { name: "slow", sql: SLOW_VALUES });
    timeoutNow();
    await expect(layerFieldStats(layer, "v")).rejects.toMatchObject({
      code: "query_timeout",
      status: 408,
    });
  }, 30_000);

  it("classification breaks time out with the documented error", async () => {
    timeoutNow();
    await expect(
      classifyFill(SLOW_VALUES, "v", "quantile"),
    ).rejects.toMatchObject({ code: "query_timeout", status: 408 });
  }, 30_000);

  it("size scales time out with the documented error", async () => {
    timeoutNow();
    await expect(
      computeSizeScale(SLOW_VALUES, "v", [0, 30]),
    ).rejects.toMatchObject({ code: "query_timeout", status: 408 });
  }, 30_000);

  it("slider previews time out with the documented error", async () => {
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(testAccountScope(), map.id, { name: "slow", sql: SLOW_VALUES });
    timeoutNow();
    await expect(sliderPreviewData(layer)).rejects.toMatchObject({
      code: "query_timeout",
      status: 408,
    });
  }, 30_000);

  it("an edit's classification recomputation times out, never degrades", async () => {
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(testAccountScope(), map.id, { name: "slow", sql: SLOW_VALUES });
    // Budget above the (shortcut-fast) inspection, below the aggregation
    // scan — pinning the timeout to the recompute itself, and proving the
    // fill fallback does not swallow the bound into a constant fill.
    process.env.DEZFIL_QUERY_TIMEOUT_S = "1";
    await expect(
      updateLayer(testAccountScope(), layer.id, {
        viz: { type: "grid", cellKm: 1, aggregate: { fn: "sum", attribute: "v" } },
      }),
    ).rejects.toMatchObject({ code: "query_timeout", status: 408 });
  }, 30_000);
});

describe("query bounds — render lanes", () => {
  it("a render times out into the errored envelope with the documented code", async () => {
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(testAccountScope(), map.id, { name: "fast", sql: FAST });
    const slow = await updateLayer(testAccountScope(), layer.id, { sql: SLOW_EVERYWHERE });
    timeoutNow();
    const render = await renderLayer(slow);
    expect(render).toMatchObject({
      ok: false,
      error: { code: "query_timeout" },
    });
  }, 30_000);

  it("a settle render with selections times out the same way", async () => {
    const map = createMap(testAccountScope(), "m");
    const created = await createLayer(testAccountScope(), map.id, { name: "slow", sql: SLOW_VALUES });
    const gridded = await updateLayer(testAccountScope(), created.id, {
      viz: {
        type: "grid",
        cellKm: 1,
        aggregate: { fn: "sum", attribute: "v" },
        // An explicit fill skips the (slow) server-side reclassification,
        // so the stored layer arrives without waiting on the full scan.
        fill: { type: "constant", color: { r: 13, g: 125, b: 92, a: 1 } },
      },
    });
    timeoutNow();
    const render = await renderLayerWithSelections(gridded, [
      { field: "v", kind: "values", values: ["1", "2"] },
    ]);
    expect(render).toMatchObject({
      ok: false,
      error: { code: "query_timeout" },
    });
  }, 30_000);
});

describe("query bounds — widget lanes", () => {
  it("widget values time out with the documented error, not per-widget noise", async () => {
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(testAccountScope(), map.id, { name: "slow", sql: SLOW_VALUES });
    const withWidgets = updateMap(testAccountScope(), map.id, {
      widgets: [
        {
          id: "wf",
          type: "formula",
          layerId: layer.id,
          title: "Avg v",
          field: "v",
          agg: "avg",
          aggField: null,
          unit: null,
          note: null,
          format: null,
          visible: true,
        },
      ],
    });
    timeoutNow();
    await expect(
      computeWidgetValues(withWidgets, withWidgets.layers, []),
    ).rejects.toMatchObject({ code: "query_timeout", status: 408 });
  }, 30_000);
});

describe("query bounds — published lanes", () => {
  it("published view assembly bounds each layer, visible as the coded error", async () => {
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(testAccountScope(), map.id, { name: "fast", sql: FAST });
    await updateLayer(testAccountScope(), layer.id, { sql: SLOW_EVERYWHERE });
    const { token } = publishMap(testAccountScope(), map.id);
    timeoutNow();
    const view = await getPublishedView(token, Date.now());
    if (!view) throw new Error("view did not assemble");
    expect(view.layers[0].render).toMatchObject({
      ok: false,
      error: { code: "query_timeout" },
    });
    // The reader-facing message is the documented copy, no engine internals.
    const failed = view.layers[0].render;
    if (failed.ok || !failed.error) {
      throw new Error("expected the errored envelope");
    }
    expect(failed.error.message).toMatch(/timeout/i);
    expect(failed.error.message).not.toMatch(/interrupt/i);
  }, 30_000);

  it("the published selection re-render route reports the coded envelope", async () => {
    const map = createMap(testAccountScope(), "m");
    const created = await createLayer(testAccountScope(), map.id, { name: "slow", sql: SLOW_VALUES });
    const gridded = await updateLayer(testAccountScope(), created.id, {
      viz: {
        type: "grid",
        cellKm: 1,
        aggregate: { fn: "sum", attribute: "v" },
        fill: { type: "constant", color: { r: 13, g: 125, b: 92, a: 1 } },
      },
    });
    // The selection's field must be one the published surface declares
    // — as every real dashboard selection is.
    updateMap(testAccountScope(), map.id, {
      widgets: [
        {
          id: "wc",
          type: "category",
          layerId: created.id,
          title: "By v",
          field: "v",
          agg: "count",
          aggField: null,
          unit: null,
          note: null,
          format: null,
          visible: true,
        },
      ],
    });
    const { token } = publishMap(testAccountScope(), map.id);
    timeoutNow();
    const response = await publishedRenderRoute(
      new Request("http://localhost:3000/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          selections: [{ field: "v", kind: "values", values: ["1"] }],
        }),
      }),
      { params: Promise.resolve({ token, layerId: gridded.id }) },
    );
    expect(response.status).toBe(200);
    const render = (await response.json()) as {
      ok: boolean;
      error?: { code: string };
    };
    expect(render).toMatchObject({
      ok: false,
      error: { code: "query_timeout" },
    });
  }, 30_000);

  it("the published widget-values route fails with the documented code", async () => {
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(testAccountScope(), map.id, { name: "slow", sql: SLOW_VALUES });
    updateMap(testAccountScope(), map.id, {
      widgets: [
        {
          id: "wf",
          type: "formula",
          layerId: layer.id,
          title: "Avg v",
          field: "v",
          agg: "avg",
          aggField: null,
          unit: null,
          note: null,
          format: null,
          visible: true,
        },
      ],
    });
    const { token } = publishMap(testAccountScope(), map.id);
    timeoutNow();
    const response = await publishedWidgetValuesRoute(
      new Request("http://localhost:3000/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ selections: [] }),
      }),
      { params: Promise.resolve({ token }) },
    );
    expect(response.status).toBe(408);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("query_timeout");
  }, 30_000);
});

describe("trailing comments: valid SQL is not broken by its own comments", () => {
  it("the workspace accepts every trailing-comment shape", async () => {
    expect((await executeQuery("SELECT * FROM stations -- note")).rowCount).toBe(3);
    expect(
      (await executeQuery("SELECT * FROM stations\n-- LIMIT 1")).rowCount,
    ).toBe(3);
    expect(
      (await executeQuery("SELECT * FROM stations; -- note")).rowCount,
    ).toBe(3);
    const literal = await executeQuery(
      "SELECT 'a -- b' AS t FROM stations LIMIT 1",
    );
    expect(literal.preview[0].t).toBe("a -- b");
  }, 30_000);

  it("a genuinely invalid query still points at the user's SQL", async () => {
    await expect(
      executeQuery("SELECT nope FROM stations -- x"),
    ).rejects.toMatchObject({
      code: "sql_error",
      message: expect.stringMatching(/nope/),
    });
  }, 30_000);

  it("layer, widget and published lanes evaluate commented SQL", async () => {
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(testAccountScope(), map.id, {
      name: "commented",
      sql: `${FAST} -- note`,
    });
    expect((await renderLayer(layer)).ok).toBe(true);

    const withWidgets = updateMap(testAccountScope(), map.id, {
      widgets: [
        {
          id: "wf",
          type: "formula",
          layerId: layer.id,
          title: "Total riders",
          field: "riders",
          agg: "sum",
          aggField: null,
          unit: null,
          note: null,
          format: null,
          visible: true,
        },
      ],
    });
    const values = await computeWidgetValues(withWidgets, withWidgets.layers, []);
    expect(values.widgets[0]).toMatchObject({ id: "wf" });
    expect(values.widgets[0]).not.toHaveProperty("error");

    const { token } = publishMap(testAccountScope(), map.id);
    const view = await getPublishedView(token, Date.now());
    if (!view) throw new Error("view did not assemble");
    expect(view.layers[0].render.ok).toBe(true);
  }, 30_000);
});

describe("query bounds — outcome attribution", () => {
  it("a value literally named 'interrupt' stays a per-widget error", async () => {
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(testAccountScope(), map.id, {
      name: "tricky",
      sql: "SELECT 'interrupt' AS v, geometry FROM stations",
    });
    const withWidgets = updateMap(testAccountScope(), map.id, {
      widgets: [
        {
          id: "wf",
          type: "formula",
          layerId: layer.id,
          title: "Avg v",
          field: "v",
          agg: "avg",
          aggField: null,
          unit: null,
          note: null,
          format: null,
          visible: true,
        },
      ],
    });
    // The engine's conversion error quotes the value; the boundary's own
    // flag — not the message text — decides, so this degrades per widget
    // instead of escaping as a request-level failure.
    const values = await computeWidgetValues(withWidgets, withWidgets.layers, []);
    expect(values.widgets[0].id).toBe("wf");
    expect(values.widgets[0]).toHaveProperty("error");
  }, 30_000);
});

describe("query bounds — the export lane", () => {
  // Layer data export is a consumer of the bounded-evaluation contract;
  // these regressions enumerate it: timeout, memory,
  // cancellation, and the hardened instance each hold for an export.
  it("an export times out with the documented error", async () => {
    timeoutNow();
    await expect(
      exportLayerResult(
        { name: "slow", sql: SLOW_EVERYWHERE, filters: [], viz: POINTS_VIZ },
        "csv",
      ),
    ).rejects.toMatchObject({ code: "query_timeout" });
  }, 30_000);

  it("an export inherits the memory budget's coded error", async () => {
    process.env.DEZFIL_QUERY_MEMORY_MB = "64";
    resetQueryInstance();
    try {
      await expect(
        exportLayerResult(
          {
            name: "hungry",
            sql: "SELECT geometry, hash(a.range) AS h FROM stations, (SELECT * FROM range(50000000) ORDER BY hash(range)) a",
            filters: [],
            viz: POINTS_VIZ,
          },
          "csv",
        ),
      ).rejects.toMatchObject({ code: "query_memory_exceeded" });
    } finally {
      delete process.env.DEZFIL_QUERY_MEMORY_MB;
      resetQueryInstance();
    }
  }, 30_000);

  it("an export cancels with its departed caller", async () => {
    const caller = new AbortController();
    const started = Date.now();
    const run = exportLayerResult(
      { name: "slow", sql: SLOW_EVERYWHERE, filters: [], viz: POINTS_VIZ },
      "csv",
      caller.signal,
    );
    setTimeout(() => caller.abort(), 150);
    await expect(run).rejects.toBeInstanceOf(EvaluationCancelled);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);

  it("an export runs on the hardened instance: writes rejected, fence held", async () => {
    // The read-only guard rejects a mutation before it can run…
    await expect(
      exportLayerResult(
        {
          name: "evil",
          sql: "DELETE FROM stations",
          filters: [],
          viz: POINTS_VIZ,
        },
        "csv",
      ),
    ).rejects.toMatchObject({ code: "sql_rejected" });
    // …and user SQL cannot read outside the fence — the main instance
    // would serve this path; the hardened one refuses it.
    await expect(
      exportLayerResult(
        {
          name: "reach",
          sql: `SELECT geometry, * FROM read_csv('${path
            .join(dir, "stations.csv")
            .replace(/'/g, "''")}')`,
          filters: [],
          viz: POINTS_VIZ,
        },
        "csv",
      ),
    ).rejects.toMatchObject({ code: "sql_error" });
  }, 30_000);
});

describe("query bounds — the memory budget", () => {
  it("a memory-hungry query fails coded and the instance keeps serving", async () => {
    process.env.DEZFIL_QUERY_MEMORY_MB = "64";
    resetQueryInstance();
    try {
      await expect(
        executeQuery(
          "SELECT count(*) FROM (SELECT * FROM range(50000000) ORDER BY hash(range)) t",
        ),
      ).rejects.toMatchObject({ code: "query_memory_exceeded" });
      const after = await executeQuery("SELECT count(*) AS n FROM stations");
      expect(after.rowCount).toBe(1);
      expect(Number(after.preview[0].n)).toBe(3);
    } finally {
      delete process.env.DEZFIL_QUERY_MEMORY_MB;
      resetQueryInstance();
    }
  }, 30_000);
});

describe("query bounds — a caller that leaves takes its work with it", () => {
  it("a builder render cancels with its departed caller", async () => {
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(testAccountScope(), map.id, { name: "fast", sql: FAST });
    const slow = await updateLayer(testAccountScope(), layer.id, { sql: SLOW_EVERYWHERE });
    const caller = new AbortController();
    const started = Date.now();
    const render = renderLayer(slow, caller.signal);
    setTimeout(() => caller.abort(), 150);
    await expect(render).rejects.toBeInstanceOf(EvaluationCancelled);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);

  it("a published view assembly cancels with its departed reader", async () => {
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(testAccountScope(), map.id, { name: "fast", sql: FAST });
    await updateLayer(testAccountScope(), layer.id, { sql: SLOW_EVERYWHERE });
    const { token } = publishMap(testAccountScope(), map.id);
    const reader = new AbortController();
    const started = Date.now();
    const view = getPublishedView(token, Date.now(), reader.signal);
    setTimeout(() => reader.abort(), 150);
    await expect(view).rejects.toBeInstanceOf(EvaluationCancelled);
    expect(Date.now() - started).toBeLessThan(10_000);
    // The abandoned assembly never populated the cache: the next reader
    // assembles fresh and, unaborted, sees the layer's own errored state.
    timeoutNow();
    const fresh = await getPublishedView(token, Date.now());
    if (!fresh) throw new Error("view did not assemble");
    expect(fresh.layers[0].render).toMatchObject({
      ok: false,
      error: { code: "query_timeout" },
    });
  }, 30_000);
});
