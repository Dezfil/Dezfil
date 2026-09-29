import { testAccountScope } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { createMap } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import { niceBreaks } from "@/lib/style/nice-breaks";
import type { AssistantContext } from "./context";
import type { AssistantEvent } from "./loop";
import { DEFAULT_MODELS } from "./config";
import type { ModelProvider, ToolOutcome } from "./provider";
import { anthropicProvider } from "./providers/anthropic";
import { openaiProvider } from "./providers/openai";
import { stubProvider, type ScriptEntry } from "./providers/stub";
import { pendingActions } from "./pending";
import { assistantRuns } from "./runs";
import { dispatchAssistantTestRoute } from "./testing/route-dispatch";

/**
 * The four analytical fixtures (the fixture table of the verification
 * record): fixed data, a task, an expectation written independently of
 * the run and asserted from stored state through the real routes, a
 * successful execution required, and a named seed each that the
 * assertion is seen to fail against. The scripted model is a compliant
 * analyst; the live arm runs the same harness with the real provider.
 * With DEZFIL_ANALYTICAL_SEED set, the compliant cases run the seeded scripts
 * instead, which is how the red log was taken.
 */

const factory = vi.hoisted(() => ({ provider: null as ModelProvider | null }));
vi.mock("@/lib/assistant/factory", () => ({ createProvider: () => factory.provider }));
const SEEDED = process.env.DEZFIL_ANALYTICAL_SEED === "1";
/** DEZFIL_ASSISTANT_LIVE=openai|anthropic: the compliant cases run the
 * real provider on the same harness, the seeds skipped, every outcome
 * recorded with the model that answered; the scripted arm is what CI
 * runs. The key is read from the environment, never discovered. */
const live = process.env.DEZFIL_ASSISTANT_LIVE as "openai" | "anthropic" | undefined;
if (live && !["openai", "anthropic"].includes(live)) throw new Error("DEZFIL_ASSISTANT_LIVE must be openai or anthropic");
const wireFetch = globalThis.fetch;
function liveProvider(): ModelProvider {
  const key = process.env[live === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"];
  expect(key, "the provider's key in the environment").toBeTruthy();
  const model = process.env.DEZFIL_AI_MODEL || DEFAULT_MODELS[live!];
  return live === "openai" ? openaiProvider(key!, model, wireFetch) : anthropicProvider(key!, model, wireFetch);
}
async function recordLive(fixture: string, outcome: { receipt: unknown; events: AssistantEvent[] }, check: () => Promise<void>) {
  let pass = true; let failure: string | undefined;
  try { await check(); } catch (error) { pass = false; failure = error instanceof Error ? error.message.split("\n")[0].slice(0, 300) : String(error); }
  const models = [...new Set(outcome.events.flatMap((e) => e.type === "message" && e.model ? [e.model] : []))];
  const out = path.join(process.cwd(), "perf-logs/assistant");
  await mkdir(out, { recursive: true });
  await appendFile(path.join(out, `assistant-fixtures-${live}.jsonl`), JSON.stringify({ at: new Date().toISOString(), provider: live, configuredModel: process.env.DEZFIL_AI_MODEL || DEFAULT_MODELS[live!], returnedModels: models, fixture, pass, failure, receipt: outcome.receipt, text: outcome.events.flatMap((e) => e.type === "message" ? [e.text] : []).join("\n").slice(0, 600) }) + "\n");
  if (!pass) throw new Error(`${fixture} live: ${failure}`);
}

const origin = "http://localhost:3208";
let dir: string;
beforeEach(async () => {
  assistantRuns.resetForTests(); pendingActions.resetForTests();
  await mkdir(path.join(process.cwd(), ".claude"), { recursive: true });
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-fixtures-test-"));
  // The automatic map check has its own suites; this one asserts its turns' exact actions.
  vi.stubEnv("DEZFIL_ASSISTANT_AUTO_CHECK", "0");
  vi.stubEnv("DEZFIL_DATA_DIR", dir); vi.stubEnv("ANTHROPIC_API_KEY", "fixture-never-sent"); vi.stubEnv("PORT", "3208");
  closeMetadataDb(); resetQueryInstance();
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => dispatchAssistantTestRoute(input instanceof Request ? input : new Request(String(input), init)));
}, 60_000);
afterEach(async () => { closeMetadataDb(); resetQueryInstance(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

const api = (url: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
  dispatchAssistantTestRoute(new Request(origin + url, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }));
async function json<T>(url: string, body?: unknown, method?: string): Promise<T> {
  const response = await api(url, body, method);
  const text = await response.text();
  if (!response.ok) throw new Error(`${method ?? "GET"} ${url}: ${response.status} ${text}`);
  return JSON.parse(text) as T;
}
type Result = Extract<AssistantEvent, { type: "tool_result" }>;
async function turn(script: ScriptEntry[], context: AssistantContext, message: string) {
  factory.provider = live ? liveProvider() : stubProvider(script);
  const runId = (await json<{ id: string }>("/api/assistant/runs", {}, "POST")).id;
  const response = await api("/api/assistant/messages", { runId, message, context });
  const text = await response.text(); expect(response.status, text).toBe(200);
  const events = text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as AssistantEvent);
  const results = events.filter((e): e is Result => e.type === "tool_result");
  return { runId, events, results, receipt: await json<{ state: string; actions: { tool: string; status: string; args?: Record<string, unknown> }[] }>(`/api/assistant/runs/${runId}`) };
}
const body = (outcomes: ToolOutcome[], index = 0) => JSON.parse(outcomes[index].body) as Record<string, unknown>;

// ---- the data (the verification record's fixture table) ----
const F2_STATIONS: [string, number, number][] = [["S1", 13.4, 52.5], ["S2", 13.42, 52.5], ["S3", 13.4, 52.52], ["S4", 13.44, 52.54], ["S5", 13.38, 52.48], ["S6", 13.46, 52.46]];
const F2_PARKS: [string, number, number, number, number, number][] = [
  ["P1", 13.4030, 13.4060, 52.4995, 52.5005, 4.2], ["P2", 13.4195, 13.4205, 52.5020, 52.5030, 0.8], ["P3", 13.3990, 13.4080, 52.5190, 52.5210, 13.0],
  ["P4", 13.4090, 13.4110, 52.4995, 52.5005, 1.5], ["P5", 13.4395, 13.4405, 52.5455, 52.5465, 0.5], ["P6", 13.3795, 13.3805, 52.4725, 52.4735, 0.9],
  ["P7", 13.55, 13.56, 52.60, 52.61, 2.0], ["P8", 13.57, 13.58, 52.61, 52.62, 0.3], ["P9", 13.59, 13.60, 52.62, 52.63, 6.5],
  ["P10", 13.60, 13.61, 52.64, 52.65, 1.1], ["P11", 13.61, 13.62, 52.65, 52.66, 0.7], ["P12", 13.56, 13.57, 52.63, 52.64, 3.3],
];
const F2_EXPECTED = ["P1", "P2", "P3"];
const F4_EXPECTED = ["P1", "P3", "P4", "P7", "P9", "P10", "P12"].sort();
const F1_VALUES = [...Array.from({ length: 30 }, (_, i) => 100 + 27 * i), ...Array.from({ length: 8 }, (_, j) => 5000 + 500 * j), 80000, 80000];
const F3_BOX = { west: 13.40, east: 13.41, south: 52.50, north: 52.51 };

const rect = (w: number, e: number, s: number, n: number) => ({ type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
const collection = (features: { properties: Record<string, unknown>; geometry: unknown }[]) => JSON.stringify({ type: "FeatureCollection", features: features.map((f) => ({ type: "Feature", ...f })) });
async function seedTable(name: string, geojson: string) {
  const file = path.join(dir, `${name}.geojson`); await writeFile(file, geojson);
  const table = await ingestFile(testAccountScope(), file, `${name}.geojson`);
  const page = await json<{ tables: { name: string; geometryColumn: string }[] }>(`/api/catalogue/tables?names=${encodeURIComponent(table.name)}`);
  return { name: table.name, geometry: page.tables[0].geometryColumn };
}
const seedF2 = async () => ({
  stations: await seedTable("stations_f2", collection(F2_STATIONS.map(([station, lon, lat]) => ({ properties: { station }, geometry: { type: "Point", coordinates: [lon, lat] } })))),
  parks: await seedTable("parks_f2", collection(F2_PARKS.map(([park, w, e, s, n, area_ha]) => ({ properties: { park, area_ha }, geometry: rect(w, e, s, n) })))),
});
const features = async (layerId: string) => (await json<{ features: { properties: Record<string, unknown> }[] }>(`/api/layers/${layerId}/export/geojson`)).features;
const parkIds = async (layerId: string) => (await features(layerId)).map((f) => String(f.properties.park)).sort();
const layer = (id: string) => json<{ id: string; name: string; sql: string; style: Record<string, unknown>; filters: unknown }>(`/api/layers/${id}`);
const metric = (expr: string) => `ST_Transform(${expr}, 'EPSG:4326', 'EPSG:25833', always_xy := true)`;

/** The ellipsoidal area of a lat-lon quadrangle on WGS84, independently of
 * the engine: the closed form for the band between two parallels. */
function ellipsoidalArea(box: { west: number; east: number; south: number; north: number }): number {
  const a = 6378137, f = 1 / 298.257223563, b = a * (1 - f), e = Math.sqrt(1 - (b * b) / (a * a));
  const band = (latDeg: number) => { const s = Math.sin(latDeg * Math.PI / 180); return s / (1 - e * e * s * s) + Math.log((1 + e * s) / (1 - e * s)) / (2 * e); };
  const dLambda = (box.east - box.west) * Math.PI / 180;
  return (b * b * dLambda / 2) * (band(box.north) - band(box.south));
}
/** Quantile_cont's linear interpolation, written here rather than read from the engine. */
function quantiles(values: number[], classes: number): number[] {
  const sorted = [...values].sort((x, y) => x - y);
  return Array.from({ length: classes - 1 }, (_, i) => {
    const pos = ((i + 1) / classes) * (sorted.length - 1);
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  });
}
const occupancy = (values: number[], breaks: number[]) => {
  const counts = new Array(breaks.length + 1).fill(0);
  for (const v of values) counts[breaks.filter((br) => v >= br).length] += 1;
  return Math.max(...counts);
};

// ---- F1: classification ----
async function seedF1() {
  const squares = F1_VALUES.map((area_m2, i) => ({ properties: { square: `Q${i + 1}`, area_m2 }, geometry: rect(13.3 + (i % 8) * 0.002, 13.3 + (i % 8) * 0.002 + 0.001, 52.3 + Math.floor(i / 8) * 0.002, 52.3 + Math.floor(i / 8) * 0.002 + 0.001) }));
  const table = await seedTable("squares_f1", collection(squares));
  const map = createMap(testAccountScope(), "F1");
  const created = await createLayer(testAccountScope(), map.id, { name: "Squares", sql: `SELECT * FROM ${table.name}` });
  return { map, layerId: created.id, style: created.style as unknown as Record<string, unknown>, context: { page: "builder", mapId: map.id, selectedLayerId: created.id } as AssistantContext };
}
/** The compliant analyst computes the fill and merges it into the layer's
 * own style, as a style is written whole (the journey's pattern). */
const f1Script = (layerId: string, style: Record<string, unknown>, method: "quantile" | "equal"): ScriptEntry[] => [
  { text: "", toolCalls: [{ id: "f1-fill", name: "compute_fill", args: { id: layerId, attribute: "area_m2", method, classes: 5 } }] },
  (outcomes) => ({ text: "", toolCalls: [{ id: "f1-apply", name: "update_layer", args: { id: layerId, style: { ...style, fill: body(outcomes) } } }] }),
  { text: "Coloured by area.", toolCalls: [] },
];
async function assertF1(layerId: string) {
  const stored = await layer(layerId);
  const fill = stored.style.fill as { type: string; method: string; breaks: number[]; classes?: number };
  expect(["quantile", "natural"], `the method for a right-skewed column, got ${fill.method}`).toContain(fill.method);
  const fields = await json<{ styling: { name: string; type: string }[] }>(`/api/layers/${layerId}/fields`);
  const type = fields.styling.find((f) => f.name === "area_m2")?.type ?? "";
  const meta = { integer: /int/i.test(type), lo: Math.min(...F1_VALUES), hi: Math.max(...F1_VALUES) };
  const classes = fill.classes ?? fill.breaks.length + 1;
  if (fill.method === "quantile") expect(fill.breaks).toEqual(niceBreaks([...new Set(quantiles(F1_VALUES, classes))], meta));
  expect(occupancy(F1_VALUES, fill.breaks), "no class holds more than 60 percent of the features").toBeLessThanOrEqual(24);
}

// ---- F2: spatial filtering ----
function f2Sql(parks: { name: string; geometry: string }, stations: { name: string; geometry: string }) {
  const p = `p.${parks.geometry}`, s = `s.${stations.geometry}`;
  const candidate = `ST_XMin(${p}) <= ST_X(${s}) + 0.0074 AND ST_XMax(${p}) >= ST_X(${s}) - 0.0074 AND ST_YMin(${p}) <= ST_Y(${s}) + 0.0045 AND ST_YMax(${p}) >= ST_Y(${s}) - 0.0045`;
  const exact = `ST_Distance(${metric(p)}, ${metric(s)}) <= 500`;
  const seeded = `ST_Intersects(ST_Envelope(${p}), ${s})`;
  const wrap = (where: string) => `SELECT p.park, p.area_ha, p.${parks.geometry} FROM ${parks.name} p WHERE EXISTS (SELECT 1 FROM ${stations.name} s WHERE ${where})`;
  return { compliant: wrap(`${candidate} AND ${exact}`), candidateOnly: wrap(candidate), seeded: wrap(seeded) };
}
const f2Script = (mapId: string, sql: string): ScriptEntry[] => [
  { text: "", toolCalls: [{ id: "f2-layer", name: "create_layer", args: { id: mapId, name: "Parks near stations", sql } }] },
  { text: "The parks within 500 m of a station.", toolCalls: [] },
];
async function assertF2(mapId: string) {
  const map = await json<{ layers: { id: string }[] }>(`/api/maps/${mapId}`);
  expect(map.layers).toHaveLength(1);
  expect(await parkIds(map.layers[0].id), "the exact result").toEqual(F2_EXPECTED);
}

// ---- F3: units ----
async function seedF3() {
  const table = await seedTable("area_f3", collection([{ properties: { area: "A" }, geometry: rect(F3_BOX.west, F3_BOX.east, F3_BOX.south, F3_BOX.north) }]));
  const map = createMap(testAccountScope(), "F3");
  const created = await createLayer(testAccountScope(), map.id, { name: "Area", sql: `SELECT * FROM ${table.name}` });
  return { table, map, layerId: created.id, context: { page: "builder", mapId: map.id, selectedLayerId: created.id } as AssistantContext };
}
const f3Script = (layerId: string, table: { name: string; geometry: string }, planarAsMetres: boolean): ScriptEntry[] => [
  { text: "", toolCalls: [{ id: "f3-measure", name: "update_layer", args: { id: layerId, sql: planarAsMetres
    ? `SELECT *, ST_Area(${table.geometry}) AS area_m2 FROM ${table.name}`
    : `SELECT *, ST_Area(${metric(table.geometry)}) AS area_m2 FROM ${table.name}` } }] },
  { text: "About 0.76 square kilometres, measured in EPSG:25833.", toolCalls: [] },
];
async function assertF3(layerId: string) {
  const [feature] = await features(layerId);
  const expected = ellipsoidalArea(F3_BOX);
  const m2 = Object.entries(feature.properties).find(([key]) => /(_m2|_sqm|square_metres)$/i.test(key));
  const deg2 = Object.entries(feature.properties).find(([key]) => /(_deg2|square_degrees)$/i.test(key));
  expect(m2 ?? deg2, "a unit-labelled analytical output").toBeDefined();
  if (m2) { const value = Number(m2[1]); expect(Math.abs(value - expected) / expected, `${m2[0]} = ${value} against ${expected.toFixed(0)} square metres`).toBeLessThan(0.01); }
  if (deg2) expect(Math.abs(Number(deg2[1]) - 0.0001)).toBeLessThan(1e-9);
}

// ---- F4: refinement ----
async function seedF4(parks: { name: string }, stations: { name: string }) {
  const map = createMap(testAccountScope(), "F4");
  const l1 = await createLayer(testAccountScope(), map.id, { name: "Parks", sql: `SELECT * FROM ${parks.name}` });
  const l2 = await createLayer(testAccountScope(), map.id, { name: "Stations", sql: `SELECT * FROM ${stations.name}` });
  const l3 = await createLayer(testAccountScope(), map.id, { name: "Large parks", sql: `SELECT * FROM ${parks.name} WHERE area_ha > 3` });
  const snapshot = async () => ({ l2: await layer(l2.id), l2ids: await features(l2.id), l3: await layer(l3.id), l3ids: await parkIds(l3.id) });
  return { map, l1: l1.id, l2: l2.id, l3: l3.id, before: await snapshot(), snapshot, context: { page: "builder", mapId: map.id, selectedLayerId: l1.id } as AssistantContext };
}
const f4Script = (target: string, mapId: string, seed: "none" | "fourth" | "wrong-layer", parks: string): ScriptEntry[] => [
  seed === "fourth"
    ? { text: "", toolCalls: [{ id: "f4-new", name: "create_layer", args: { id: mapId, name: "Parks over a hectare", sql: `SELECT * FROM ${parks} WHERE area_ha > 1` } }] }
    : { text: "", toolCalls: [{ id: "f4-refine", name: "update_layer", args: { id: target, filters: [{ kind: "range", field: "area_ha", min: 1, max: null }] } }] },
  { text: "This layer now shows parks over one hectare.", toolCalls: [] },
];
async function assertF4(f4: Awaited<ReturnType<typeof seedF4>>) {
  const map = await json<{ layers: { id: string }[] }>(`/api/maps/${f4.map.id}`);
  expect(map.layers, "the map still holds exactly three layers").toHaveLength(3);
  expect(map.layers.map((l) => l.id)).toContain(f4.l1);
  expect(await parkIds(f4.l1), "the selected layer's effective ids").toEqual(F4_EXPECTED);
  const after = await f4.snapshot();
  expect(after, "the two untouched layers").toEqual(f4.before);
}

describe("F1: classification", () => {
  it("colours a right-skewed area by quantile or natural breaks, the stored boundaries recomputed independently, no class over 60 percent", async () => {
    const f1 = await seedF1();
    const outcome = await turn(f1Script(f1.layerId, f1.style, SEEDED ? "equal" : "quantile"), f1.context, "Colour these by area using a classification that suits how skewed the values are");
    if (live) { await recordLive("F1", outcome, () => assertF1(f1.layerId)); return; }
    expect(outcome.receipt.actions.map((a) => a.status)).toEqual(["succeeded", "succeeded"]);
    await assertF1(f1.layerId);
  }, 300_000);
  it.skipIf(Boolean(live))("seed: equal intervals put 38 of 40 in one class and fail the method and occupancy assertions", async () => {
    const f1 = await seedF1();
    const { receipt } = await turn(f1Script(f1.layerId, f1.style, "equal"), f1.context, "Colour these by area");
    expect(receipt.actions.map((a) => a.status)).toEqual(["succeeded", "succeeded"]);
    await expect(assertF1(f1.layerId)).rejects.toThrow(/the method for a right-skewed column, got equal/);
    const fill = (await layer(f1.layerId)).style.fill as { breaks: number[] };
    expect(occupancy(F1_VALUES, fill.breaks)).toBeGreaterThanOrEqual(38);
  }, 60_000);
});

describe("F2: spatial filtering", () => {
  it("keeps the two non-overlapping matches and the boundary-crossing one, the candidate filter alone conservative", async () => {
    const { stations, parks } = await seedF2();
    const map = createMap(testAccountScope(), "F2");
    const sql = f2Sql(parks, stations);
    const outcome = await turn(f2Script(map.id, SEEDED ? sql.seeded : sql.compliant), { page: "builder", mapId: map.id, selectedLayerId: null }, "Which parks are within 500 m of a station? Make one layer of exactly those parks on this map, keeping the park column");
    if (live) { await recordLive("F2", outcome, () => assertF2(map.id)); return; }
    expect(outcome.receipt.actions.map((a) => a.status)).toEqual(["succeeded"]);
    await assertF2(map.id);
    const candidates = (await json<{ preview: Record<string, unknown>[] }>("/api/query", { sql: sql.candidateOnly })).preview.map((r) => String(r.park));
    for (const id of F2_EXPECTED) expect(candidates, "the candidate filter alone is conservative").toContain(id);
  }, 300_000);
  it.skipIf(Boolean(live))("seed: an unexpanded bounding-box overlap loses P1 and P2", async () => {
    const { stations, parks } = await seedF2();
    const map = createMap(testAccountScope(), "F2 seed");
    await turn(f2Script(map.id, f2Sql(parks, stations).seeded), { page: "builder", mapId: map.id, selectedLayerId: null }, "Which parks are within 500 m of a station?");
    await expect(assertF2(map.id)).rejects.toThrow(/the exact result/);
    const [only] = (await json<{ layers: { id: string }[] }>(`/api/maps/${map.id}`)).layers;
    expect(await parkIds(only.id)).toEqual(["P3"]);
  }, 60_000);
});

describe("F3: units", () => {
  it("stores a square-metre area within 1 percent of the ellipsoidal value computed independently", async () => {
    const f3 = await seedF3();
    const outcome = await turn(f3Script(f3.layerId, f3.table, SEEDED), f3.context, "How large is this area? Add its area as a column of this layer, named for its unit (for example area_m2 for square metres)");
    if (live) { await recordLive("F3", outcome, () => assertF3(f3.layerId)); return; }
    expect(outcome.receipt.actions.map((a) => a.status)).toEqual(["succeeded"]);
    await assertF3(f3.layerId);
    expect(ellipsoidalArea(F3_BOX)).toBeGreaterThan(7.4e5); expect(ellipsoidalArea(F3_BOX)).toBeLessThan(7.7e5);
  }, 300_000);
  it.skipIf(Boolean(live))("seed: the planar area labelled square metres fails by four orders of magnitude", async () => {
    const f3 = await seedF3();
    await turn(f3Script(f3.layerId, f3.table, true), f3.context, "How large is this area?");
    await expect(assertF3(f3.layerId)).rejects.toThrow(/area_m2 = (0\.0001|0\.00009)/);
  }, 60_000);
});

describe("F4: refinement", () => {
  it("refines the selected layer by identity, count and effective result, the others untouched", async () => {
    const { stations, parks } = await seedF2();
    const f4 = await seedF4(parks, stations);
    const outcome = await turn(f4Script(f4.l1, f4.map.id, SEEDED ? "fourth" : "none", parks.name), f4.context, "Make this one show only parks over one hectare");
    if (live) { await recordLive("F4", outcome, () => assertF4(f4)); return; }
    expect(outcome.receipt.actions.map((a) => a.status)).toEqual(["succeeded"]);
    await assertF4(f4);
  }, 300_000);
  it.skipIf(Boolean(live))("seed: a fourth layer instead fails the count and identity assertions", async () => {
    const { stations, parks } = await seedF2();
    const f4 = await seedF4(parks, stations);
    await turn(f4Script(f4.l1, f4.map.id, "fourth", parks.name), f4.context, "Make this one show only parks over one hectare");
    await expect(assertF4(f4)).rejects.toThrow(/exactly three layers/);
  }, 60_000);
  it.skipIf(Boolean(live))("seed: editing a different layer fails the untouched-layer assertion", async () => {
    const { stations, parks } = await seedF2();
    const f4 = await seedF4(parks, stations);
    await turn(f4Script(f4.l3, f4.map.id, "wrong-layer", parks.name), f4.context, "Make this one show only parks over one hectare");
    await expect(assertF4(f4)).rejects.toThrow(/the selected layer's effective ids|the two untouched layers/);
  }, 60_000);
});
