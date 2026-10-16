import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "@/lib/api/errors";
import type { AccountScope } from "@/lib/auth/scope";
import { dataDir } from "@/lib/config";
import { resetQueryInstance } from "@/lib/duckdb";
import { renderLayer } from "@/lib/layer-render";
import * as renderFeatures from "@/lib/query/render-features";
import { NUMERIC_SETTINGS } from "@/lib/settings/numeric";
import { testAccountScope } from "@/lib/test-support/accounts";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";
import { buildTemplate, installFixture, type BuiltTemplate, type TemplateFiles } from "../../../test-support/templates/builder";
import { copyTemplate } from "./copy";
import { installTemplateArchive } from "./install";
import { readTemplateLayer, readTemplateMap } from "./map-read";
import * as renderCap from "./render-cap";
import { TemplateRefusal } from "./refusals";

/**
 * A new template version is admitted against the defaults of the render cap
 * and of Bytes drawn per layer, each layer's answer counted as its view
 * will render it: the same result, the properties its map's widgets and
 * timeline read, and the live filters its docked timeline delegates. A
 * layer over the default answers template_invalid naming the limit, and
 * neither a higher nor a lower limit set on this instance changes that. A
 * version installed before stays as it is: it opens and copies, and its
 * excess shows in its layer's render.
 *
 * Bytes drawn per layer's default is 128 MiB, more than a fixture should
 * draw, so these cases lower the default itself for their run and set this
 * instance's limit apart from it.
 */

const STATIONS = "template.harbour-stations.1.layer.layer-stations";
const DISTRICTS = "template.harbour-stations.1.layer.layer-districts";
const MAP = "template.harbour-stations.1.map";
// Written for a run only, restored after each case.
const bytesSetting = NUMERIC_SETTINGS.find((setting) => setting.key === "renderCapBytes")! as { defaultValue: number };
const DEFAULT_BYTES = bytesSetting.defaultValue;

/** The stations layer under four ranges and a time range on the field the
 * map's timeline docks, with no automatic interaction fields: docked, the
 * time range ships to the canvas in place of the fourth range and the
 * stations carry the docked field, so the answer depends on the map's
 * timeline. */
const docked = (files: TemplateFiles) => {
  const map = files.documents.get("maps/map.json")!;
  const layers = map.layers as Record<string, unknown>[];
  const wide = { field: "riders", kind: "range", min: 0, max: 1000 };
  Object.assign(layers.find((layer) => layer.id === "layer-stations")!, {
    tooltip: [], popup: [],
    filters: [wide, wide, wide, wide, { field: "opened", kind: "timerange", min: "2021-01-01", max: null }],
  });
  map.timeline = { layerId: "layer-stations", field: "opened", speed: 1 };
};

/** The districts layer with no automatic interaction fields, a widget of
 * the map reading its population, and a one-station stations layer: the
 * districts' answer carries the population only for the map's widget. */
const widgetRead = (files: TemplateFiles) => {
  const map = files.documents.get("maps/map.json")!;
  const layers = map.layers as Record<string, unknown>[];
  layers.find((layer) => layer.id === "layer-stations")!.sql = "SELECT * FROM stations WHERE riders = 410";
  Object.assign(layers.find((layer) => layer.id === "layer-districts")!, { tooltip: [], popup: [] });
  (map.widgets as Record<string, unknown>[]).push({
    id: "widget-population", type: "formula", layerId: "layer-districts", title: "Population", field: "population",
    agg: "sum", aggField: null, unit: null, note: null, format: null, visible: true,
  });
};

let built: string;
let T: BuiltTemplate;
let W: BuiltTemplate;
let f: ReturnType<typeof instanceSettingsFixture>;
let scope: AccountScope;
let attempt = 0;

beforeAll(async () => {
  built = await mkdtemp(path.join(process.cwd(), ".tmp-test-template-bytes-"));
  T = await buildTemplate(path.join(built, "t"), { id: "harbour-stations", edit: docked });
  W = await buildTemplate(path.join(built, "w"), { id: "harbour-stations", edit: widgetRead });
});
afterAll(async () => { await rm(built, { recursive: true, force: true }); });

beforeEach(() => {
  f = instanceSettingsFixture();
  resetQueryInstance();
  scope = testAccountScope(f.db, "member");
});
afterEach(() => {
  bytesSetting.defaultValue = DEFAULT_BYTES;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetQueryInstance();
  f.close();
});

/** Bytes drawn per layer's default, for this run. */
const defaultBytes = (bytes: number) => { bytesSetting.defaultValue = bytes; };
/** This instance's own Bytes drawn per layer. */
const instanceBytes = (bytes: number) => vi.stubEnv("DEZFIL_RENDER_CAP_BYTES", String(bytes));

const installed = () => path.join(dataDir(), "templates", "harbour-stations", "1");
const install = (template = T) => installFixture(template, installed(), { kind: "catalogue", origin: "https://catalogue.example" });

/** Install the archive by the install's own road: null when admitted, else
 * the refusal. An admitted version is taken out again, so the next
 * admission reads nothing of the map but what the version itself holds. */
async function admit(template: BuiltTemplate): Promise<TemplateRefusal | null> {
  const scratch = path.join(dataDir(), `install-${attempt++}`);
  await mkdir(scratch, { recursive: true });
  const expected = { id: template.facts.id, version: template.facts.version, size: template.size, sha256: template.sha256 };
  try {
    await installTemplateArchive(scope, scratch, template.archive, expected, { kind: "catalogue", origin: "https://catalogue.example" });
    await rm(installed(), { recursive: true, force: true });
    return null;
  } catch (error) {
    if (error instanceof TemplateRefusal) return error;
    throw error;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const size = (answer: unknown) => Buffer.byteLength(JSON.stringify(answer), "utf8");
const view = (id: string) => renderLayer(scope, readTemplateLayer(scope, id));

/** The least Bytes drawn per layer the installed version's view draws the
 * layer within, read from the view: its answer, or, over that, the answer
 * it falls back to with every filter applied on the server. */
async function threshold(id: string): Promise<{ bytes: number; fellBack: boolean }> {
  instanceBytes(DEFAULT_BYTES);
  const first = await view(id);
  expect(first, id).toMatchObject({ ok: true, mode: "inline" });
  instanceBytes(size(first) - 1);
  const fallback = await view(id);
  const bytes = fallback.ok ? size(fallback) : size(first);
  instanceBytes(bytes - 1);
  expect(await view(id), id).toMatchObject({ ok: false, error: { code: "render_bytes_exceeded" } });
  instanceBytes(DEFAULT_BYTES);
  return { bytes, fellBack: fallback.ok };
}

/** The refusal of the map's layer at `ordinal` (from 1) named `name`. */
const overBytes = (limit: number, ordinal = 1, name = "Stations") =>
  `The map's layer ${ordinal} ("${name}") draws more than ${limit.toLocaleString()} bytes, the limit for one layer drawn in the map. ` +
  "A template's layer draws within the limit, its large data as an aggregation or a slice.";

describe("a new template version and Bytes drawn per layer", () => {
  it("is admitted exactly at the least default its view draws within, counted as its view renders it, and refused one byte under, naming the limit", async () => {
    await install();
    // The docked timeline decides the stations' answer: every station ships
    // with the time range delegated, and over the limit the render falls
    // back to every filter applied on the server.
    instanceBytes(DEFAULT_BYTES);
    expect(await view(STATIONS)).toMatchObject({ featureCount: 6, liveFiltered: true });
    const live = size(await view(STATIONS));
    const stations = await threshold(STATIONS);
    expect(stations.fellBack).toBe(true);
    const districts = await threshold(DISTRICTS);
    const layers = readTemplateMap(scope, MAP).layers;
    const least = Math.max(stations.bytes, districts.bytes);
    const ordinal = layers.findIndex((layer) => layer.id === (least === stations.bytes ? STATIONS : DISTRICTS));
    expect(stations.bytes).not.toBe(districts.bytes);
    expect(live - 1).toBeGreaterThanOrEqual(least);
    // Admitted while not installed, so nothing of the map is read but what
    // the version itself holds.
    await rm(installed(), { recursive: true, force: true });

    // The stations' own answer does not fit; the one it falls back to does.
    defaultBytes(live - 1);
    expect(await admit(T)).toBeNull();
    defaultBytes(least);
    expect(await admit(T)).toBeNull();
    defaultBytes(least - 1);
    expect(await admit(T)).toMatchObject({ code: "template_invalid", message: overBytes(least - 1, ordinal + 1, layers[ordinal].name) });
    // The stations come first, and carry the docked field: one byte under
    // their fallback, they are what is refused.
    defaultBytes(stations.bytes - 1);
    expect(await admit(T)).toMatchObject({ code: "template_invalid", message: overBytes(stations.bytes - 1) });
  });

  it("counts the properties its map's widgets read, as its view does", async () => {
    await install(W);
    const drawn = (await view(DISTRICTS)).geojson as { features: { properties: Record<string, unknown> }[] };
    expect(Object.keys(drawn.features[0].properties).sort()).toEqual(["__anchor", "population"]);
    const stations = await threshold(STATIONS);
    const districts = await threshold(DISTRICTS);
    expect(districts.bytes).toBeGreaterThan(stations.bytes);
    await rm(installed(), { recursive: true, force: true });

    defaultBytes(districts.bytes);
    expect(await admit(W)).toBeNull();
    defaultBytes(districts.bytes - 1);
    expect(await admit(W)).toMatchObject({ code: "template_invalid", message: overBytes(districts.bytes - 1, 2, "Districts") });
  });

  it("holds every instance to the default: a higher limit here admits nothing over it, a lower one refuses nothing under it", async () => {
    defaultBytes(64);
    instanceBytes(1_000_000_000);
    expect(await admit(T)).toMatchObject({ code: "template_invalid", message: overBytes(64) });
    bytesSetting.defaultValue = DEFAULT_BYTES;
    instanceBytes(64);
    expect(await admit(T)).toBeNull();
  });

  it("keeps an evaluation's own refusal, and words the render's other refusals for where they came from", async () => {
    // The deadline runs out while the stations' answer is read.
    const timeout = new ApiError("query_timeout", "The query ran past its time limit.", 408);
    vi.spyOn(renderFeatures, "buildInlineAnswer").mockRejectedValueOnce(timeout);
    await expect(admit(T)).rejects.toBe(timeout);
    vi.spyOn(renderCap, "templateLayerRender").mockResolvedValueOnce({ layerId: STATIONS, ok: false, error: { code: "invalid_request", message: "This layer's query no longer returns a geometry column." } });
    expect(await admit(T)).toMatchObject({ code: "template_invalid", message: `The map's layer 1 ("Stations"): This layer's query no longer returns a geometry column.` });
  });
});

describe("a version installed before, over the default", () => {
  it("still opens and copies, and its excess shows in its layer's render", async () => {
    await install();
    defaultBytes(64);
    // Admitted now, it would be refused.
    instanceBytes(DEFAULT_BYTES);
    const refusal = await admit(T);
    expect(refusal).toMatchObject({ code: "template_invalid", message: overBytes(64) });

    expect(readTemplateMap(scope, MAP).layers.map((layer) => layer.id).sort()).toEqual([DISTRICTS, STATIONS]);
    expect(await renderLayer(scope, readTemplateLayer(scope, STATIONS))).toMatchObject({ ok: true, mode: "inline", featureCount: 6 });
    instanceBytes(256);
    expect(await renderLayer(scope, readTemplateLayer(scope, STATIONS))).toMatchObject({ ok: false, error: { code: "render_bytes_exceeded" } });

    instanceBytes(DEFAULT_BYTES);
    const copy = await copyTemplate(scope, "harbour-stations", {}, f.db);
    expect(copy.members.maps).toHaveLength(1);
    expect(copy.members.tables.map((table) => table.name).sort()).toEqual(["districts", "stations"]);
  });
});
