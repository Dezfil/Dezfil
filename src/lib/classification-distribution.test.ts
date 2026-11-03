import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { testClient } from "@/lib/mcp/test-client";
import { journeyClient } from "../../scripts/mcp-journey-core.mjs";
import { FIELD_STATS_CASES, FIELD_STATS_SQL } from "../../test-support/field-stats/cases";
import { distributionAxis, distributionEdges, type ClassificationDistribution } from "./classification-distribution";

/**
 * The statistics read's classification distribution, through the HTTP
 * route and the MCP tool: the values a classification sees (filters
 * applied, the aggregate on cells), on a log axis for skewed positive
 * values and a linear one otherwise, binned equal on that axis, with the
 * edges and the whole-number fact. The bins are checked against counts
 * made here, over the same values, from the returned edges alone. A
 * request without the option answers the bytes it answered before the
 * option existed, recorded then.
 */

let dir: string;
let client: Awaited<ReturnType<typeof testClient>>;
let journey: Awaited<ReturnType<typeof journeyClient>>;
const get = (url: string) => dispatchAssistantTestRoute(new Request(`http://localhost:3307${url}`));

beforeAll(async () => {
  await mkdir(".claude", { recursive: true });
  dir = await mkdtemp(`${process.cwd()}/.tmp-class-distribution-`);
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
  closeMetadataDb();
  resetQueryInstance();
  client = await testClient(dispatchAssistantTestRoute);
  journey = await journeyClient(client, async (url: string) => (await get(url)).json());
});
afterAll(async () => {
  await client?.close();
  closeMetadataDb();
  resetQueryInstance();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

/** A layer over the given values, one point each. */
function valuesSql(values: number[], type = "INTEGER"): string {
  return `SELECT list_extract([${values.join(", ")}], i + 1)::${type} AS v,
    ST_Point(13 + (i % 40) * 0.01, 52 + (i // 40) * 0.01) AS geometry
    FROM range(0, ${values.length}) AS t(i)`;
}

async function layer(sql: string, fields: Record<string, unknown> = {}): Promise<{ id: string }> {
  const map = await journey.call("create_map", { name: "Distribution" });
  const created = await journey.call("create_layer", { id: map.id, name: "L", expected_revision: map.editRevision, sql });
  if (Object.keys(fields).length > 0) {
    const current = await journey.call("get_layer", { id: created.id });
    await journey.call("update_layer", { id: created.id, expected_revision: current.editRevision, ...fields });
  }
  return created;
}

async function distribution(l: { id: string }, field = "v"): Promise<ClassificationDistribution> {
  const response = await get(`/api/layers/${l.id}/fields/${field}?distribution=classification`);
  expect(response.status).toBe(200);
  return response.json();
}

/** Counts made here: each value in the bin whose returned edges hold it. */
function counted(values: number[], edges: number[]): number[] {
  const inner = edges.slice(1, -1);
  const bins = new Array<number>(edges.length - 1).fill(0);
  for (const v of values) bins[inner.filter((e) => v >= e).length] += 1;
  return bins;
}

/** 1,239 skewed whole counts: 736 ones, 194 twos, 68 threes and a thinning
 * tail from 4 to 73, the shape of collisions per hexagon. */
const COLLISIONS = [
  ...new Array(736).fill(1),
  ...new Array(194).fill(2),
  ...new Array(68).fill(3),
  ...Array.from({ length: 241 }, (_, k) => 4 + Math.floor(69 * (k / 240) ** 3)),
];
/** Evenly spread populations, the shape of districts. */
const POPULATION = Array.from({ length: 120 }, (_, k) => 20_000 + k * 1_500);

describe("the classification distribution", () => {
  it("draws skewed positive counts on a log axis, bins equal on it", async () => {
    const d = await distribution(await layer(valuesSql(COLLISIONS)));
    expect(d).toMatchObject({ distribution: "classification", axis: "log", wholeNumbers: true, min: 1, max: 73 });
    expect(d.edges).toHaveLength(d.bins.length + 1);
    expect([d.edges[0], d.edges.at(-1)]).toEqual([1, 73]);
    const widths = d.edges.slice(1).map((e, k) => Math.log(e) - Math.log(d.edges[k]));
    for (const w of widths) expect(w).toBeCloseTo(Math.log(73) / d.bins.length, 12);
    expect(d.bins).toEqual(counted(COLLISIONS, d.edges));
    expect(d.bins.reduce((a, b) => a + b, 0)).toBe(COLLISIONS.length);
    // The three small classes land in three different bins.
    const bin = (v: number) => counted([v], d.edges).indexOf(1);
    expect(new Set([bin(1), bin(2), bin(3)]).size).toBe(3);
  });

  it("keeps evenly spread values on a linear axis", async () => {
    const d = await distribution(await layer(valuesSql(POPULATION)));
    expect(d.axis).toBe("linear");
    const widths = d.edges.slice(1).map((e, k) => e - d.edges[k]);
    for (const w of widths) expect(w).toBeCloseTo((d.max! - d.min!) / d.bins.length, 6);
    expect(d.bins).toEqual(counted(POPULATION, d.edges));
  });

  it("stays linear with a zero, with a negative value, and gives no bins for a single value", async () => {
    const zero = [0, ...COLLISIONS];
    const withZero = await distribution(await layer(valuesSql(zero)));
    expect(withZero.axis).toBe("linear");
    expect(withZero.bins).toEqual(counted(zero, withZero.edges));
    const negative = [-1, ...COLLISIONS];
    expect((await distribution(await layer(valuesSql(negative)))).axis).toBe("linear");
    const single = await distribution(await layer(valuesSql([5, 5, 5])));
    expect(single).toMatchObject({ axis: "linear", bins: [], edges: [], min: 5, max: 5 });
  });

  it("counts a value on an inner edge in the bin above it, and the maximum in the last", async () => {
    // On 0 to 40 the forty linear edges are the whole numbers themselves.
    const values = Array.from({ length: 41 }, (_, k) => k);
    const d = await distribution(await layer(valuesSql(values)));
    expect(d.edges).toEqual(values);
    expect(d.bins).toEqual([...new Array(39).fill(1), 2]);
    expect(d.bins).toEqual(counted(values, d.edges));
  });

  it("reads the effective result: filters applied, unlike the plain request", async () => {
    const l = await layer(valuesSql(COLLISIONS), { filters: [{ field: "v", kind: "range", min: 3, max: null }] });
    const kept = COLLISIONS.filter((v) => v >= 3);
    const d = await distribution(l);
    expect([d.min, d.max]).toEqual([3, 73]);
    expect(d.bins).toEqual(counted(kept, d.edges));
    expect((await (await get(`/api/layers/${l.id}/fields/v`)).json()).min).toBe(1);
  });

  it("reads cells' value and count, whole per field", async () => {
    const counts = await layer(valuesSql(COLLISIONS), { viz: { type: "hexbin", cellKm: 3, aggregate: { fn: "count" } } });
    expect((await distribution(counts, "value")).wholeNumbers).toBe(true);
    const average = await layer(valuesSql(COLLISIONS), { viz: { type: "hexbin", cellKm: 3, aggregate: { fn: "avg", attribute: "v" } } });
    const value = await distribution(average, "value");
    expect(value.wholeNumbers).toBe(false);
    expect((await distribution(average, "count")).wholeNumbers).toBe(true);
    const plain = await (await get(`/api/layers/${average.id}/fields/value`)).json();
    expect([value.min, value.max]).toEqual([plain.min, plain.max]);
    // The engine sums in parallel, so two reads of one mean can differ in
    // the last bit.
    expect(value.mean).toBeCloseTo(plain.mean, 9);
  });

  it("finds a decimal column not whole, on whichever axis its values ask for", async () => {
    const d = await distribution(await layer(valuesSql(POPULATION.map((p) => p / 7), "DOUBLE")));
    expect(d).toMatchObject({ wholeNumbers: false, axis: "linear" });
  });

  it("refuses a field that is not numeric and an unknown option", async () => {
    const l = await layer(`SELECT 'a' || i AS label, ST_Point(13, 52) AS geometry FROM range(0, 3) AS t(i)`);
    const text = await get(`/api/layers/${l.id}/fields/label?distribution=classification`);
    expect([text.status, (await text.json()).error.code]).toEqual([400, "invalid_request"]);
    const unknown = await get(`/api/layers/${l.id}/fields/label?distribution=everything`);
    expect([unknown.status, (await unknown.json()).error.code]).toEqual([400, "invalid_request"]);
  });

  it("answers the same through the MCP tool", async () => {
    const l = await layer(valuesSql(COLLISIONS));
    expect(await journey.call("get_field_stats", { id: l.id, field: "v", distribution: "classification" })).toEqual(await distribution(l));
  });
});

describe("the axis and its edges", () => {
  it("is log only for positive, spread values whose mean sits in the lowest quarter", () => {
    expect(distributionAxis(1, 73, 3.88)).toBe("log");
    expect(distributionAxis(1, 73, 19)).toBe("linear");
    expect(distributionAxis(0, 73, 3)).toBe("linear");
    expect(distributionAxis(-2, 73, 3)).toBe("linear");
    expect(distributionAxis(5, 5, 5)).toBe("linear");
  });

  it("keeps the extent's ends exactly", () => {
    const edges = distributionEdges(0.3, 1234.5678, "log");
    expect([edges[0], edges.at(-1)]).toEqual([0.3, 1234.5678]);
    for (let k = 1; k < edges.length; k++) expect(edges[k]).toBeGreaterThan(edges[k - 1]);
  });
});

describe("a request without the option", () => {
  it("answers the bytes recorded before the option existed", async () => {
    const recorded = JSON.parse(await readFile("test-support/field-stats/recorded.json", "utf8")) as Record<string, string>;
    expect(Object.keys(recorded)).toEqual(FIELD_STATS_CASES.map((c) => c.name));
    for (const c of FIELD_STATS_CASES) {
      const l = await layer(FIELD_STATS_SQL, { ...(c.viz ? { viz: c.viz } : {}), ...(c.filters ? { filters: c.filters } : {}) });
      const answer = await (await get(`/api/layers/${l.id}/fields/${encodeURIComponent(c.field)}`)).text();
      expect(answer, c.name).toBe(recorded[c.name]);
    }
  });
});
