import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { testClient } from "@/lib/mcp/test-client";
import type { LayerViz } from "@/lib/viz";
import type { FillPaint, LayerStyle, QuantileFill } from "@/lib/style/style";
import { journeyClient } from "../../scripts/mcp-journey-core.mjs";

/**
 * The cells' fill the server makes when nothing numeric is there to carry
 * starts on the method its values suit: Natural breaks when the cells
 * count, Quantile when they average, sum or take an extreme. When Natural
 * cannot classify the values (every cell holds the same count) the
 * automatic choice asks Quantile instead; a method the caller asks for, or
 * one the layer's paint already holds, is kept as before, and a Natural the
 * paint holds keeps its name over Quantile's classes when a filter leaves
 * values it cannot classify. Seeded defects: the fixed Quantile this
 * replaced, which fails the count cases, and the constant that a refused
 * held Natural fell to, which a lifted filter then kept.
 */

let dir: string;
let client: Awaited<ReturnType<typeof testClient>>;
let journey: Awaited<ReturnType<typeof journeyClient>>;
const api = async (url: string) =>
  (await dispatchAssistantTestRoute(new Request(`http://localhost:3308${url}`))).json();

beforeAll(async () => {
  await mkdir(".claude", { recursive: true });
  dir = await mkdtemp(`${process.cwd()}/.tmp-automatic-method-`);
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
  closeMetadataDb();
  resetQueryInstance();
  client = await testClient(dispatchAssistantTestRoute);
  journey = await journeyClient(client, api);
});
afterAll(async () => {
  await client?.close();
  closeMetadataDb();
  resetQueryInstance();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

/** Skewed whole counts and a decimal column over 200 points in a block of
 * cells. */
const SQL = `SELECT (i % 7 + i // 50)::INTEGER AS n, i * 0.37 AS x,
  ST_Point(13 + (i % 20) * 0.02, 52 + (i // 20) * 0.02) AS geometry
  FROM range(0, 200) AS t(i)`;
/** Thirty points a degree apart: at a kilometre each cell holds exactly one. */
const SPREAD_SQL = `SELECT i AS n, ST_Point(i, 10) AS geometry FROM range(0, 30) AS t(i)`;

interface Stored { id: string; editRevision: string; style: LayerStyle; viz: LayerViz }

async function layer(sql = SQL, style?: (current: LayerStyle) => LayerStyle): Promise<Stored> {
  const map = await journey.call("create_map", { name: "Automatic method" });
  const made: Stored = await journey.call("create_layer", { id: map.id, name: "Cells", expected_revision: map.editRevision, sql });
  return style ? update(made, { style: style(made.style) }) : made;
}
const read = (l: { id: string }): Promise<Stored> => journey.call("get_layer", { id: l.id });
async function update(l: { id: string }, fields: Record<string, unknown>): Promise<Stored> {
  const current = await read(l);
  return journey.call("update_layer", { id: l.id, expected_revision: current.editRevision, ...fields });
}
const cells = (aggregate: Record<string, unknown>, cellKm = 2) => ({ viz: { type: "hexbin", cellKm, aggregate } });
const cellsFill = (l: Stored): FillPaint | undefined => (l.viz.type === "hexbin" || l.viz.type === "grid" ? l.viz.fill : undefined);
const methodOf = (paint: FillPaint | undefined) =>
  paint?.type === "quantile" ? paint.method : paint?.type;
const compute = (l: { id: string }, attribute: string, method: string): Promise<QuantileFill> =>
  journey.call("compute_fill", { id: l.id, attribute, method });

describe("the cells' fill the server makes", () => {
  it("starts on Natural breaks when the cells count, with nothing numeric to carry", async () => {
    const l = await layer();
    const made = cellsFill(await update(l, cells({ fn: "count" })));
    expect(methodOf(made)).toBe("natural");
    expect((made as QuantileFill).wholeNumbers).toBe(true);
  });

  it("starts on Quantile when the cells average, sum or take an extreme", async () => {
    for (const fn of ["avg", "sum", "min", "max"]) {
      const l = await layer();
      const made = cellsFill(await update(l, cells({ fn, attribute: "x" })));
      expect(methodOf(made), fn).toBe("quantile");
    }
  });

  it("asks Quantile when every cell holds the same count, where Natural finds no boundary", async () => {
    const l = await layer(SPREAD_SQL);
    // Asked for by name, Natural refuses these values as before.
    await update(l, cells({ fn: "count" }, 1));
    await journey.call("compute_fill", { id: l.id, attribute: "value", method: "natural" }, "invalid_request");
    const fresh = await layer(SPREAD_SQL);
    const made = cellsFill(await update(fresh, cells({ fn: "count" }, 1)));
    expect(made?.type).toBe("quantile");
    expect(methodOf(made)).toBe("quantile");
  });

  it("keeps classed cells and their method through a filter that leaves every cell the same count", async () => {
    // Thirty points a degree apart, ten more stacked on the first: one cell
    // holds eleven, the rest one each, until the stacked ten are filtered out.
    const l = await layer(`SELECT (i >= 30)::INTEGER AS extra,
      ST_Point(CASE WHEN i >= 30 THEN 0 ELSE i END, 10) AS geometry FROM range(0, 40) AS t(i)`);
    const made = cellsFill(await update(l, cells({ fn: "count" }, 1)));
    expect(methodOf(made)).toBe("natural");
    const filtered = cellsFill(await update(l, { filters: [{ field: "extra", kind: "range", min: 0, max: 0 }] }));
    expect(filtered?.type).toBe("quantile");
    expect(methodOf(filtered)).toBe("natural");
    const unfiltered = cellsFill(await update(l, { filters: [] }));
    expect(unfiltered).toEqual(made);
  });

  it("keeps a saved method, an absent one as Quantile, Custom's own and a continuous scale", async () => {
    const base = await layer();
    const quantile = await compute(base, "n", "quantile");
    const equal = await compute(base, "n", "equal");
    const continuous = await compute(base, "n", "continuous");
    const { method: _absent, ...noMethod } = quantile;
    void _absent;
    const custom: QuantileFill = { ...equal, method: "custom", baseMethod: "equal", breaks: equal.breaks.map((b) => b + 0.5) };
    const cases: [FillPaint, string | undefined][] = [
      [quantile, "quantile"], [equal, "equal"], [noMethod as FillPaint, "quantile"], [custom, "equal"], [continuous, "continuous"],
    ];
    for (const [fill, expected] of cases) {
      const l = await layer(SQL, (style) => ({ ...style, fill }));
      expect(methodOf(cellsFill(await update(l, cells({ fn: "count" })))), JSON.stringify(fill.type === "quantile" ? fill.method ?? "absent" : fill.type)).toBe(expected);
    }
  });

  it("carries the method of the cells' own fill through a change of aggregation", async () => {
    const l = await layer();
    await update(l, cells({ fn: "count" }));
    // The panel drops the fill to ask for a new one over the new values.
    const averaged = cellsFill(await update(l, cells({ fn: "avg", attribute: "x" })));
    expect(methodOf(averaged)).toBe("natural");
  });

  it("keeps a fill the caller sends", async () => {
    const l = await layer();
    await update(l, cells({ fn: "count" }));
    const sent = await compute(l, "value", "quantile");
    const kept = cellsFill(await update(l, { viz: { ...cells({ fn: "count" }).viz, fill: sent } }));
    expect(methodOf(kept)).toBe("quantile");
  });
});
