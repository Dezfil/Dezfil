import { testAccountScope } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { removeTable } from "@/lib/table-service";
import { createMap } from "@/lib/map-service";
import {
  createLayer,
  renderLayer,
  requireLayer,
  updateLayer,
} from "@/lib/layer-service";
import { computeWidgetValues } from "@/lib/widget-service";
import { getMap } from "@/lib/metadata/maps";
import { updateMap } from "@/lib/map-service";
import { ApiError } from "@/lib/api/errors";
import type { LayerStyle, QuantileFill } from "@/lib/style/style";

/**
 * Write-time column-reference validation on the layer write paths: a
 * write that introduces a reference the result cannot honor refuses
 * with the documented code and persists nothing, while echoes of stored
 * references, SQL edits that strand references, and the
 * aggregated-label normalization all keep their existing behavior.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
  const source = path.join(dir, "trips.csv");
  await writeFile(
    source,
    [
      "name,cat,val,lon,lat",
      "r1,A,10,13.40,52.50",
      "r2,B,20,13.41,52.51",
      "r3,C,30,13.42,52.52",
    ].join("\n"),
  );
  await ingestFile(testAccountScope(), source, "trips.csv");
});

afterEach(async () => {
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

const rgba = { r: 10, g: 20, b: 30, a: 1 };

const quantileOn = (attribute: string): QuantileFill => ({
  type: "quantile",
  attribute,
  palette: "viridis",
  breaks: [15],
  colors: [rgba, rgba],
});

const constantStyle: LayerStyle = {
  fill: { type: "constant", color: rgba },
  fillOpacity: 1,
  stroke: rgba,
  strokeOpacity: 1,
  strokeWidth: 1,
  pointRadius: 4,
  opacity: 1,
};

async function makeLayer() {
  const map = createMap(testAccountScope(), "writes");
  return createLayer(map.id, {
    name: "Trips",
    sql: "SELECT name, cat, val, geometry FROM trips",
  });
}

async function refused(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error("expected the write to be refused");
}

describe("layer style writes", () => {
  it("refuses a fill on a nonexistent column and persists nothing", async () => {
    const layer = await makeLayer();
    const style = { ...constantStyle, fill: quantileOn("typo") };
    const error = await refused(updateLayer(layer.id, { style, name: "x" }));
    expect(error.code).toBe("column_unavailable");
    expect(error.status).toBe(400);
    expect(error.message).toContain('"typo"');
    const stored = requireLayer(layer.id);
    expect(stored.style.fill.type).toBe("constant");
    expect(stored.name).toBe("Trips");
  });

  it("refuses a numeric channel on a text column, naming both kinds", async () => {
    const layer = await makeLayer();
    const style = { ...constantStyle, fill: quantileOn("cat") };
    const error = await refused(updateLayer(layer.id, { style }));
    expect(error.code).toBe("column_unavailable");
    expect(error.message).toContain('"cat" is text');
  });

  it("accepts valid data-driven channels", async () => {
    const layer = await makeLayer();
    const style = {
      ...constantStyle,
      fill: quantileOn("val"),
      pointRadiusBy: {
        attribute: "val",
        domain: [10, 30] as [number, number],
        range: [2, 10] as [number, number],
      },
      label: { attribute: "name", size: 12, color: rgba, haloWidth: 1, haloColor: { r: 12, g: 16, b: 24, a: 0.8 } },
    };
    const updated = await updateLayer(layer.id, { style });
    expect(updated.style.fill.type).toBe("quantile");
  });

  it("a SQL edit stranding a stored reference is never refused, and the echo passes after it", async () => {
    const layer = await makeLayer();
    await updateLayer(layer.id, {
      style: { ...constantStyle, fill: quantileOn("val") },
    });
    // The edit drops `val`; the stored fill now references a stranded
    // column. Refusing the edit (or the later echo) would brick the
    // surface — read-time degradation owns this class.
    const narrowed = await updateLayer(layer.id, {
      sql: "SELECT name, cat, geometry FROM trips",
    });
    expect(narrowed.sql).toContain("name, cat, geometry");
    const echoed = await updateLayer(layer.id, {
      style: { ...requireLayer(layer.id).style },
      name: "still here",
    });
    expect(echoed.name).toBe("still here");
    expect((echoed.style.fill as QuantileFill).attribute).toBe("val");
  });

  it("the same stranded reference introduced anew is refused", async () => {
    const layer = await makeLayer();
    await updateLayer(layer.id, {
      sql: "SELECT name, cat, geometry FROM trips",
    });
    const error = await refused(
      updateLayer(layer.id, {
        style: { ...constantStyle, fill: quantileOn("val") },
      }),
    );
    expect(error.code).toBe("column_unavailable");
  });

  it("style validates against the schema the same request produces", async () => {
    const layer = await makeLayer();
    // `total` exists only under the new SQL; the combined write passes.
    const combined = await updateLayer(layer.id, {
      sql: "SELECT name, val * 2 AS total, geometry FROM trips",
      style: { ...constantStyle, fill: quantileOn("total") },
    });
    expect((combined.style.fill as QuantileFill).attribute).toBe("total");
    // The inverse: a reference introduced by the same request that
    // removes its column refuses — the post-request schema decides.
    const fresh = await makeLayer();
    const error = await refused(
      updateLayer(fresh.id, {
        sql: "SELECT name, geometry FROM trips",
        style: { ...constantStyle, fill: quantileOn("val") },
      }),
    );
    expect(error.code).toBe("column_unavailable");
  });

  it("an unresolvable schema refuses new references but not other writes", async () => {
    const source = path.join(dir, "doomed.csv");
    await writeFile(source, "name,val,lon,lat\nr1,10,13.4,52.5");
    await ingestFile(testAccountScope(), source, "doomed.csv");
    const map = createMap(testAccountScope(), "drift");
    const layer = await createLayer(map.id, {
      name: "Doomed",
      sql: "SELECT name, val, geometry FROM doomed",
    });
    await removeTable("doomed");
    const error = await refused(
      updateLayer(layer.id, {
        style: { ...constantStyle, fill: quantileOn("val") },
      }),
    );
    expect(error.code).toBe("column_unavailable");
    expect(error.message).toContain("could not be resolved");
    const renamed = await updateLayer(layer.id, { name: "still editable" });
    expect(renamed.name).toBe("still editable");
  });

  it("a created layer's style references validate", async () => {
    const map = createMap(testAccountScope(), "creates");
    const error = await refused(
      createLayer(map.id, {
        name: "bad",
        sql: "SELECT name, val, geometry FROM trips",
        style: { ...constantStyle, fill: quantileOn("typo") },
      }),
    );
    expect(error.code).toBe("column_unavailable");
    const ok = await createLayer(map.id, {
      name: "good",
      sql: "SELECT name, val, geometry FROM trips",
      style: { ...constantStyle, fill: quantileOn("val") },
    });
    expect(ok.style.fill.type).toBe("quantile");
  });

  it("an aggregated write keeps dropping the label attribute instead of refusing it", async () => {
    const layer = await makeLayer();
    const updated = await updateLayer(layer.id, {
      viz: { type: "hexbin", cellKm: 1, aggregate: { fn: "count" } },
      style: {
        ...constantStyle,
        label: { attribute: "name", size: 12, color: rgba, haloWidth: 1, haloColor: { r: 12, g: 16, b: 24, a: 0.8 } },
      },
    });
    expect(updated.style.label?.attribute).toBeUndefined();
  });
});

describe("filter writes", () => {
  it("the control kind decides the needed field kind", async () => {
    const layer = await makeLayer();
    const timeOnNumeric = await refused(
      updateLayer(layer.id, {
        filters: [{ field: "val", kind: "timerange", min: null, max: null }],
      }),
    );
    expect(timeOnNumeric.code).toBe("column_unavailable");
    expect(timeOnNumeric.message).toContain("needs a time column");
    const rangeOnText = await refused(
      updateLayer(layer.id, {
        filters: [{ field: "cat", kind: "range", min: 0, max: 1 }],
      }),
    );
    expect(rangeOnText.code).toBe("column_unavailable");
    const valuesOnMissing = await refused(
      updateLayer(layer.id, {
        filters: [{ field: "typo", kind: "values", values: ["A"] }],
      }),
    );
    expect(valuesOnMissing.code).toBe("column_unavailable");
    const ok = await updateLayer(layer.id, {
      filters: [
        { field: "val", kind: "range", min: 10, max: 30 },
        { field: "cat", kind: "values", values: ["A"] },
      ],
    });
    expect(ok.filters).toHaveLength(2);
  });

  it("a stranded filter echoes through; a new entry on the same column refuses", async () => {
    const layer = await makeLayer();
    await updateLayer(layer.id, {
      filters: [{ field: "val", kind: "range", min: 10, max: 30 }],
    });
    await updateLayer(layer.id, {
      sql: "SELECT name, cat, geometry FROM trips",
    });
    const stored = requireLayer(layer.id);
    const echoed = await updateLayer(layer.id, {
      filters: stored.filters,
      name: "still filtered",
    });
    expect(echoed.name).toBe("still filtered");
    const error = await refused(
      updateLayer(layer.id, {
        filters: [
          ...stored.filters,
          { field: "val", kind: "values", values: ["10"] },
        ],
      }),
    );
    expect(error.code).toBe("column_unavailable");
  });
});

describe("read lanes stay degradation, never retro-refusal", () => {
  it("a stranded filter errors the render envelope; a stranded widget errors per-widget; unrelated writes keep working", async () => {
    const map = createMap(testAccountScope(), "drift-reads");
    const layer = await createLayer(map.id, {
      name: "Trips",
      sql: "SELECT name, cat, val, geometry FROM trips",
    });
    // An aggregated layer folds its references into server SQL — the read
    // lane that visibly errors on drift (points delegate filters to the
    // GPU and keep rendering).
    await updateLayer(layer.id, {
      viz: {
        type: "hexbin",
        cellKm: 1,
        aggregate: { fn: "sum", attribute: "val" },
      },
    });
    updateMap(map.id, {
      widgets: [
        {
          id: "wh",
          type: "histogram",
          layerId: layer.id,
          title: "Vals",
          field: "val",
          agg: "count",
          aggField: null,
          unit: null,
          note: null,
          format: null,
          visible: true,
        },
      ],
    });
    // Drift: the column vanishes under stored references (the mechanism a
    // refresh shares — the read path cannot tell why it is gone).
    await updateLayer(layer.id, {
      sql: "SELECT name, cat, geometry FROM trips",
    });
    const render = await renderLayer(requireLayer(layer.id));
    expect(render.ok).toBe(false);
    if (!render.ok) expect(render.error?.code).toBe("sql_error");
    const values = await computeWidgetValues(
      getMap(map.id)!,
      [requireLayer(layer.id)],
      [],
    );
    expect(values.widgets).toHaveLength(1);
    expect("error" in values.widgets[0]).toBe(true);
    const renamed = await updateLayer(layer.id, { name: "still working" });
    expect(renamed.name).toBe("still working");
  });
});

describe("viz writes", () => {
  it("aggregations and weights need numeric base columns", async () => {
    const layer = await makeLayer();
    const onText = await refused(
      updateLayer(layer.id, {
        viz: {
          type: "hexbin",
          cellKm: 1,
          aggregate: { fn: "sum", attribute: "cat" },
        },
      }),
    );
    expect(onText.code).toBe("column_unavailable");
    expect(onText.message).toContain("aggregation needs a numeric column");
    const onMissing = await refused(
      updateLayer(layer.id, {
        viz: {
          type: "heatmap",
          radiusPx: 30,
          intensity: 1,
          weight: "typo",
        },
      }),
    );
    expect(onMissing.code).toBe("column_unavailable");
    const ok = await updateLayer(layer.id, {
      viz: {
        type: "hexbin",
        cellKm: 1,
        aggregate: { fn: "sum", attribute: "val" },
      },
    });
    expect(ok.viz.type).toBe("hexbin");
  });

  it("elevation aggregates validate like the cell aggregate", async () => {
    const layer = await makeLayer();
    const error = await refused(
      updateLayer(layer.id, {
        viz: {
          type: "grid",
          cellKm: 1,
          aggregate: { fn: "count" },
          elevation: {
            aggregate: { fn: "avg", attribute: "name" },
            height: 500,
          },
        },
      }),
    );
    expect(error.code).toBe("column_unavailable");
    expect(error.message).toContain("elevation aggregation");
  });

  it("O→D endpoints resolve against geometry or numeric coordinate columns", async () => {
    const layer = await makeLayer();
    const notGeometry = await refused(
      updateLayer(layer.id, {
        viz: {
          type: "arc",
          origin: { kind: "geometry", field: "name" },
          dest: null,
          height: 0.6,
        },
      }),
    );
    expect(notGeometry.code).toBe("column_unavailable");
    expect(notGeometry.message).toContain("not a geometry column");
    const badCoord = await refused(
      updateLayer(layer.id, {
        viz: {
          type: "arc",
          origin: null,
          dest: { kind: "lonlat", lon: "cat", lat: "val" },
          height: 0.6,
        },
      }),
    );
    expect(badCoord.code).toBe("column_unavailable");
    const ok = await updateLayer(layer.id, {
      viz: {
        type: "arc",
        origin: { kind: "geometry", field: "geometry" },
        dest: null,
        height: 0.6,
      },
    });
    expect(ok.viz.type).toBe("arc");
  });

  it("a cluster color aggregate validates", async () => {
    const layer = await makeLayer();
    const error = await refused(
      updateLayer(layer.id, {
        viz: {
          type: "cluster",
          radiusPx: 40,
          color: { fn: "max", attribute: "cat" },
          showCounts: true,
        },
      }),
    );
    expect(error.code).toBe("column_unavailable");
    const ok = await updateLayer(layer.id, {
      viz: {
        type: "cluster",
        radiusPx: 40,
        color: { fn: "max", attribute: "val" },
        showCounts: true,
      },
    });
    expect(ok.viz.type).toBe("cluster");
  });
});

describe("column-list writes", () => {
  it("tooltip and pop-up names must exist in the result", async () => {
    const layer = await makeLayer();
    const error = await refused(
      updateLayer(layer.id, { tooltip: ["name", "typo"] }),
    );
    expect(error.code).toBe("column_unavailable");
    expect(error.message).toContain('"typo"');
    const ok = await updateLayer(layer.id, {
      tooltip: ["name", "val"],
      popup: ["cat"],
    });
    expect(ok.tooltip).toEqual(["name", "val"]);
  });

  it("aggregated tooltips draw from the derived set; published fields stay base columns", async () => {
    const layer = await makeLayer();
    await updateLayer(layer.id, {
      viz: { type: "hexbin", cellKm: 1, aggregate: { fn: "count" } },
    });
    const baseRef = await refused(
      updateLayer(layer.id, { tooltip: ["name"] }),
    );
    expect(baseRef.code).toBe("column_unavailable");
    const derived = await updateLayer(layer.id, { tooltip: ["value", "count"] });
    expect(derived.tooltip).toEqual(["value", "count"]);
    // The published-field list names base columns even on an aggregated
    // layer — projection intersects the base result.
    const published = await updateLayer(layer.id, {
      publishedFields: ["name", "val"],
    });
    expect(published.publishedFields).toEqual(["name", "val"]);
    const bogus = await refused(
      updateLayer(layer.id, { publishedFields: ["typo"] }),
    );
    expect(bogus.code).toBe("column_unavailable");
  });
});
