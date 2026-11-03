import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { testClient } from "@/lib/mcp/test-client";
import { legendFor } from "@/lib/style/legend";
import { effectiveStyle, type LayerViz } from "@/lib/viz";
import type { FillPaint, LayerStyle, QuantileFill } from "@/lib/style/style";
import { journeyClient } from "../../scripts/mcp-journey-core.mjs";

/**
 * A classed paint's whole-number fact, end to end through the MCP tools
 * an agent calls and the HTTP read beside them: computing classes returns
 * it and saves nothing; saving carries it at every paint location; a write
 * that changes the SQL or the aggregation clears it from every stored
 * paint it keeps, while a paint the caller sends, or the server
 * recomputes, carries its own. Each clearing case seeds the fact first, so
 * its absence afterwards is the write's doing. Seeded defects, each shown
 * failing before the rule it guards existed: a classification that
 * returned no fact, a validator that admitted any value, and an update
 * path that kept a stale fact after a SQL change.
 */

let dir: string;
let client: Awaited<ReturnType<typeof testClient>>;
let journey: Awaited<ReturnType<typeof journeyClient>>;
const api = async (url: string) =>
  (await dispatchAssistantTestRoute(new Request(`http://localhost:3307${url}`))).json();

beforeAll(async () => {
  await mkdir(".claude", { recursive: true });
  dir = await mkdtemp(`${process.cwd()}/.tmp-whole-fact-`);
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
 * cells; `n` and `x` are the coloured fields. */
const SQL = `SELECT (i % 7 + i // 50)::INTEGER AS n, i * 0.37 AS x,
  ST_Point(13 + (i % 20) * 0.02, 52 + (i // 20) * 0.02) AS geometry
  FROM range(0, 200) AS t(i)`;
/** The same values, now typed as doubles. */
const DECIMAL_SQL = SQL.replace("::INTEGER AS n", "::DOUBLE AS n");

interface Stored {
  id: string;
  editRevision: string;
  style: LayerStyle;
  viz: LayerViz;
}

async function layer(style?: LayerStyle): Promise<Stored> {
  const map = await journey.call("create_map", { name: "Whole numbers" });
  return journey.call("create_layer", {
    id: map.id,
    name: "Counts",
    expected_revision: map.editRevision,
    sql: SQL,
    ...(style ? { style } : {}),
  });
}
const read = (l: { id: string }): Promise<Stored> => journey.call("get_layer", { id: l.id });
const compute = (l: { id: string }, attribute: string, extra: Record<string, unknown> = {}): Promise<QuantileFill> =>
  journey.call("compute_fill", { id: l.id, attribute, method: "quantile", ...extra });
async function update(l: { id: string }, fields: Record<string, unknown>, expectedCode?: string): Promise<Stored> {
  const current = await read(l);
  return journey.call("update_layer", { id: l.id, expected_revision: current.editRevision, ...fields }, expectedCode);
}
const fact = (paint: FillPaint | undefined) =>
  paint && paint.type === "quantile" ? paint.wholeNumbers : "not classed";
const cellsFill = (l: Stored) => (l.viz.type === "hexbin" || l.viz.type === "grid" ? l.viz.fill : undefined);

describe("computing classes", () => {
  it("returns the fact per coloured field and saves nothing", async () => {
    const l = await layer();
    const before = await read(l);
    const history = await journey.call("get_history", { id: (await api(`/api/layers/${l.id}`)).mapId });
    expect(fact(await compute(l, "n"))).toBe(true);
    expect(fact(await compute(l, "x"))).toBe(false);
    expect(fact(await compute(l, "n", { method: "natural", classes: 4 }))).toBe(true);
    expect(fact(await compute(l, "n", { method: "equal", palette: "viridis" }))).toBe(true);
    expect(await read(l)).toEqual(before);
    expect(await journey.call("get_history", { id: (await api(`/api/layers/${l.id}`)).mapId })).toEqual(history);
  });

  it("finds a count whole and an average not, on the cells of one layer", async () => {
    const l = await layer();
    await update(l, { viz: { type: "hexbin", cellKm: 2, aggregate: { fn: "avg", attribute: "n" } } });
    expect(fact(await compute(l, "count"))).toBe(true);
    expect(fact(await compute(l, "value"))).toBe(false);
    await update(l, { viz: { type: "hexbin", cellKm: 2, aggregate: { fn: "count" } } });
    expect(fact(await compute(l, "value"))).toBe(true);
  });

  it("sets the fact afresh on every computation after the data turned decimal", async () => {
    const l = await layer();
    await update(l, { style: { ...(await read(l)).style, fill: await compute(l, "n") } });
    await update(l, { sql: DECIMAL_SQL });
    for (const extra of [{ method: "natural" }, { classes: 3 }, { palette: "viridis" }]) {
      expect(fact(await compute(l, "n", extra))).toBe(false);
    }
  });
});

describe("saving and reading the fact", () => {
  it("is read back at the fill and the outline through MCP and the API", async () => {
    const l = await layer();
    const paint = await compute(l, "n");
    await update(l, { style: { ...(await read(l)).style, fill: paint, strokeBy: paint } });
    const viaTool = await read(l);
    const viaApi = await api(`/api/layers/${l.id}`);
    for (const stored of [viaTool, viaApi]) {
      expect(fact(stored.style.fill)).toBe(true);
      expect(fact(stored.style.strokeBy)).toBe(true);
    }
  });

  it("is carried by the cells' fill the server makes, and by one the caller sends", async () => {
    const l = await layer();
    await update(l, { viz: { type: "hexbin", cellKm: 2, aggregate: { fn: "count" } } });
    expect(fact(cellsFill(await read(l)))).toBe(true);
    const value = await compute(l, "value");
    await update(l, { viz: { type: "hexbin", cellKm: 2, aggregate: { fn: "count" }, fill: { ...value, wholeNumbers: false } } });
    expect(fact(cellsFill(await read(l)))).toBe(false);
    expect(fact(cellsFill(await api(`/api/layers/${l.id}`)))).toBe(false);
  });

  it("is admitted at creation when it is true or false", async () => {
    const probe = await layer();
    const paint = await compute(probe, "n");
    const created = await layer({ ...probe.style, fill: { ...paint, wholeNumbers: false }, strokeBy: paint });
    const stored = await read(created);
    expect(fact(stored.style.fill)).toBe(false);
    expect(fact(stored.style.strokeBy)).toBe(true);
  });

  it("refuses a fact that is not true or false at every paint location", async () => {
    const l = await layer();
    const paint = await compute(l, "n");
    const style = (await read(l)).style;
    const map = await journey.call("create_map", { name: "Refused" });
    await journey.call("create_layer", {
      id: map.id, name: "Bad", expected_revision: map.editRevision, sql: SQL,
      style: { ...style, fill: { ...paint, wholeNumbers: "yes" } },
    }, "invalid_request");
    await update(l, { style: { ...style, strokeBy: { ...paint, wholeNumbers: 1 } } }, "invalid_request");
    await update(l, { viz: { type: "hexbin", cellKm: 2, aggregate: { fn: "count" }, fill: { ...paint, attribute: "value", wholeNumbers: "no" } } }, "invalid_request");
    expect(await read(l)).toMatchObject({ style });
  });
});

describe("a write that changes what the paints classified", () => {
  async function seededPoints(): Promise<Stored> {
    const l = await layer();
    const paint = await compute(l, "n");
    await update(l, { style: { ...(await read(l)).style, fill: paint, strokeBy: paint } });
    const seeded = await read(l);
    expect([fact(seeded.style.fill), fact(seeded.style.strokeBy)]).toEqual([true, true]);
    return seeded;
  }

  async function seededCells(): Promise<Stored> {
    const l = await seededPoints();
    await update(l, { viz: { type: "hexbin", cellKm: 2, aggregate: { fn: "count" } } });
    const seeded = await read(l);
    // The fill and outline are dormant under the cells, and kept whole for
    // this check: the aggregation change cleared them, so seed them again.
    await update(l, { style: { ...seeded.style, fill: { ...seeded.style.fill, wholeNumbers: true } as FillPaint } });
    const cells = await read(l);
    expect([fact(cells.style.fill), fact(cellsFill(cells))]).toEqual([true, true]);
    return cells;
  }

  it("clears it from the fill and outline a SQL change keeps", async () => {
    const l = await seededPoints();
    await update(l, { sql: DECIMAL_SQL });
    const after = await read(l);
    expect([fact(after.style.fill), fact(after.style.strokeBy)]).toEqual([undefined, undefined]);
    expect(legendFor(after.style)?.paints[0].entries.map((e) => e.label)[1]).toMatch(/ – /);
  });

  it("keeps the fact of a paint sent with the change, echoed or stated", async () => {
    const echoed = await seededPoints();
    await update(echoed, { sql: DECIMAL_SQL, style: echoed.style });
    expect(fact((await read(echoed)).style.fill)).toBe(true);
    const stated = await seededPoints();
    const fill = { ...stated.style.fill, wholeNumbers: false } as FillPaint;
    await update(stated, { sql: DECIMAL_SQL, style: { ...stated.style, fill } });
    expect(fact((await read(stated)).style.fill)).toBe(false);
  });

  it("leaves it alone on a write that changes neither", async () => {
    const l = await seededPoints();
    await update(l, { name: "Renamed", filters: [{ field: "n", kind: "range", min: 1, max: null }] });
    const after = await read(l);
    expect([fact(after.style.fill), fact(after.style.strokeBy)]).toEqual([true, true]);
  });

  it("clears it from the cells' fill and the dormant fill on a SQL change", async () => {
    const l = await seededCells();
    await update(l, { sql: SQL.replace("i * 0.37", "i * 0.5") });
    const after = await read(l);
    expect([fact(after.style.fill), fact(cellsFill(after))]).toEqual([undefined, undefined]);
  });

  it("gives the recomputed cells a fresh fact and clears the dormant fill on an aggregation change", async () => {
    const l = await seededCells();
    await update(l, { viz: { type: "hexbin", cellKm: 2, aggregate: { fn: "avg", attribute: "n" } } });
    const after = await read(l);
    expect(fact(cellsFill(after))).toBe(false);
    expect(fact(after.style.fill)).toBeUndefined();
  });

  it("clears the fill on entering and on leaving the cells", async () => {
    const entering = await seededPoints();
    await update(entering, { viz: { type: "grid", cellKm: 5, aggregate: { fn: "count" } } });
    const cells = await read(entering);
    expect([fact(cells.style.fill), fact(cells.style.strokeBy), fact(cellsFill(cells))]).toEqual([undefined, undefined, true]);
    const leaving = await seededCells();
    await update(leaving, { viz: { type: "points" } });
    expect(fact((await read(leaving)).style.fill)).toBeUndefined();
  });

  it("gives the cells a fresh fact when filters or the cell size reclassify them", async () => {
    const l = await seededCells();
    const stored = cellsFill(await read(l))!;
    await update(l, { viz: { type: "hexbin", cellKm: 2, aggregate: { fn: "count" }, fill: { ...stored, wholeNumbers: false } } });
    expect(fact(cellsFill(await read(l)))).toBe(false);
    await update(l, { filters: [{ field: "n", kind: "range", min: 1, max: null }] });
    expect(fact(cellsFill(await read(l)))).toBe(true);
    await update(l, { viz: { type: "hexbin", cellKm: 2, aggregate: { fn: "count" }, fill: { ...stored, wholeNumbers: false } } });
    await update(l, { viz: { type: "hexbin", cellKm: 3, aggregate: { fn: "count" } } });
    const after = await read(l);
    expect(fact(cellsFill(after))).toBe(true);
    expect(legendFor(effectiveStyle(after.style, after.viz), after.viz)?.paints[0].entries[0].label).toMatch(/^≤ /);
  });
});
