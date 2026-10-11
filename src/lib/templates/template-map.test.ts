import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database, Statement } from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { GET as readMapRoute } from "@/app/api/maps/[id]/route";
import { GET as renderRoute } from "@/app/api/layers/[id]/render/route";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { authenticateSession, createApiToken } from "@/lib/auth/credentials";
import { gateRequest } from "@/lib/auth/gate";
import { PERMISSION_REFUSAL } from "@/lib/auth/reach";
import { dataDir } from "@/lib/config";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { createLayer } from "@/lib/layer-service";
import { createMap } from "@/lib/map-service";
import { insertTable } from "@/lib/metadata/tables";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import { UNKNOWN_TABLE_MESSAGE } from "@/lib/query/engine-message";
import { testAccountScope } from "@/lib/test-support/accounts";
import { shareProject } from "@/lib/test-support/sharing";
import { executeTool } from "@/lib/tools/execute";
import { buildTools } from "@/lib/tools/tools";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";
import {
  FIXTURE_CREDIT_NOTE,
  SEEDS,
  buildTemplate,
  installFixture,
  writeShippedFolder,
  type BuiltTemplate,
} from "../../../test-support/templates/builder";
import * as shippedIndex from "./shipped-index";

/**
 * A template's map, opened: read from its installed folder through the real
 * map and layer routes, by cookie, by token and by tool, for every
 * signed-in account, and nothing else. Its layers render inline, its
 * widgets, extent and search answer, every write road refuses it with the
 * permission refusal, the roads that have nothing of a template's refuse it
 * as missing, and no store query ever carries its id. Its datasets answer
 * its own layers and widgets alone: a console query, a person's layer and a
 * template's layer naming anyone else's dataset are each refused from their
 * own surface, and neither the data listing nor the catalogue read names
 * them. Opening it changes nothing stored.
 *
 * Three installed versions: a map template shipped in the image, a
 * workflow example downloaded (its map draws the bundled results), and a
 * downloaded template whose layer names a dataset of no template's, placed
 * by hand since the admission would refuse it. The member owns a dataset
 * named like that one.
 */

const ORIGIN = "http://instance.test";

// Ids written out here rather than minted, so a change in their form fails.
const MAP = "template.harbour-stations.1.map";
const STATIONS = "template.harbour-stations.1.layer.layer-stations";
const DISTRICTS = "template.harbour-stations.1.layer.layer-districts";
const W_MAP = "template.busy-stations.1.map";
const RINGS = "template.busy-stations.1.layer.layer-rings";
const BUSY = "template.busy-stations.1.layer.layer-busy";
const STRAY_MAP = "template.stray-roads.1.map";
const STRAY_STATIONS = "template.stray-roads.1.layer.layer-stations";
const TEMPLATE_ID = /template\.(harbour-stations|busy-stations|stray-roads)\./;

// The fixture's rows, stated independently of the code under test.
const STATION_NAMES = ["Harbour", "Market", "Bridge", "Hill", "Park", "Docks"];
const RIDERS_TOTAL = 340 + 220 + 180 + 90 + 60 + 410;
const BUSY_TOTAL = 340 + 220 + 180 + 410;
const STATIONS_BOX = [-0.1412, 51.4988, -0.1003, 51.5129];

let built: string;
let M1: BuiltTemplate, W1: BuiltTemplate, X1: BuiltTemplate, D1: BuiltTemplate;
let f: ReturnType<typeof instanceSettingsFixture>;
let dir: string;
let memberToken: string;
let ownLayer: string;
let roads: { id: string; name: string };

beforeAll(async () => {
  built = await mkdtemp(path.join(process.cwd(), ".tmp-test-template-map-"));
  M1 = await buildTemplate(path.join(built, "m1"), { id: "harbour-stations" });
  W1 = await buildTemplate(path.join(built, "w1"), { kind: "workflow", id: "busy-stations" });
  X1 = await buildTemplate(path.join(built, "x1"), { id: "stray-roads", edit: SEEDS.layerReferenceOutside });
  // The stations layer with more live filters than the canvas takes, the
  // last a time range on the field the map's timeline docks: the docked
  // one is delegated in place of the fourth range.
  D1 = await buildTemplate(path.join(built, "d1"), {
    id: "docked-stations",
    edit: (files) => {
      const map = files.documents.get("maps/map.json")!;
      const layers = map.layers as Record<string, unknown>[];
      const wide = { field: "riders", kind: "range", min: 0, max: 1000 };
      layers.find((layer) => layer.id === "layer-stations")!.filters = [wide, wide, wide, wide,
        { field: "opened", kind: "timerange", min: "2021-01-01", max: null }];
      map.timeline = { layerId: "layer-stations", field: "opened", speed: 1 };
    },
  });
});
afterAll(async () => { await rm(built, { recursive: true, force: true }); });

beforeEach(async () => {
  f = instanceSettingsFixture();
  resetQueryInstance();
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-template-map-run-"));
  vi.spyOn(shippedIndex, "shippedTemplatesDir").mockReturnValue(await writeShippedFolder(path.join(dir, "shipped"), [M1]));
  const downloads = path.join(dataDir(), "templates");
  await installFixture(W1, path.join(downloads, "busy-stations", "1"), { kind: "catalogue", origin: "https://catalogue.example" });
  await installFixture(X1, path.join(downloads, "stray-roads", "1"), { kind: "catalogue", origin: "https://catalogue.example" });
  memberToken = createApiToken(authenticateSession(f.member.secret, f.db)!, "Member", f.db).secret;

  // The member's own `roads`, and a map of theirs whose layer names a
  // template's dataset by its plain name (written in the store: the
  // layer write would refuse it).
  const member = testAccountScope(f.db, "member");
  const csv = path.join(dir, "roads.csv");
  await writeFile(csv, "sentinel,lon,lat\nmember roads,1,2\n");
  roads = await ingestFile(member, csv, "roads.csv");
  shareProject("member", "P", [["admin", "viewer"]], [roads.id], f.db);
  const own = createMap(member, "Own", "P");
  const layer = await createLayer(member, own.id, { name: "Roads", sql: "SELECT * FROM roads" },
    { expectedRevision: readDocumentRevision({ kind: "map", id: own.id }, f.db)?.editRevision });
  f.db.prepare("UPDATE layers SET sql = ? WHERE id = ?").run("SELECT * FROM stations", layer.id);
  ownLayer = layer.id;
});
afterEach(async () => {
  resetQueryInstance();
  f.close();
  await rm(dir, { recursive: true, force: true });
});

type Headers = Record<string, string>;
const byCookie = (): Headers => ({ cookie: `dezfil_session=${f.member.secret}`, origin: ORIGIN });
const byAdminCookie = (): Headers => ({ cookie: `dezfil_session=${f.admin.secret}`, origin: ORIGIN });
const byToken = (): Headers => ({ authorization: `Bearer ${memberToken}` });

async function call(method: string, route: string, headers: Headers, body?: unknown) {
  const response = await dispatchAssistantTestRoute(socketRequest(new Request(`${ORIGIN}${route}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })));
  const text = await response.text();
  const json = response.headers.get("content-type")?.includes("json") && text ? JSON.parse(text) : null;
  return { status: response.status, body: json as Record<string, unknown> | null, text };
}

const tool = (name: string) => buildTools().find((candidate) => candidate.name === name)!;
const dispatch = (secret: string) => (async (input: RequestInfo | URL, init?: RequestInit) => {
  const incoming = input instanceof Request ? input : new Request(String(input), init);
  const headers = new Headers(incoming.headers);
  headers.set("authorization", `Bearer ${secret}`);
  return dispatchAssistantTestRoute(socketRequest(new Request(incoming, { headers })));
}) as typeof fetch;

type Feature = { properties: Record<string, unknown>; geometry: { type: string } };
const featuresOf = (body: unknown) => ((body as { geojson: { features: Feature[] } }).geojson.features);

/** The state opening a template must leave as it was: every table but the
 * credentials' (a cookie or token request records its last use), and every
 * file of the data folder outside the downloads, but for the artifacts the
 * engine reads a template's own files through. */
async function protectedState(db: Database) {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'auth_%' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
    .map(({ name }) => [name, JSON.stringify(db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all())]);
  const staged = new Set(await templateArtifacts());
  const files: string[] = [];
  const walk = async (folder: string, prefix: string) => {
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (relative === "templates" || staged.has(relative)) continue;
      if (entry.isDirectory()) await walk(path.join(folder, entry.name), relative);
      else files.push(`${relative}:${createHash("sha256").update(await readFile(path.join(folder, entry.name))).digest("hex")}`);
    }
  };
  await walk(dataDir(), "");
  return { tables, files: files.sort() };
}

/** The engine's artifacts of the three versions' own files: named by the
 * content of a dataset or bundled result the versions hold, nothing else. */
async function templateArtifacts(): Promise<string[]> {
  const shas = new Set<string>();
  for (const t of [M1, W1, X1]) {
    for (const [name, bytes] of t.files.binaries) {
      if (name.endsWith(".parquet")) shas.add(createHash("sha256").update(bytes).digest("hex"));
    }
  }
  return [...shas].map((sha) => `tables/template-${sha}.parquet`);
}

/** Every statement run on the store while `work` runs, with its parameters. */
async function statementsDuring(db: Database, work: () => Promise<void>): Promise<string[]> {
  const seen: string[] = [];
  const prepare = db.prepare.bind(db);
  const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
    const statement = prepare(sql) as Statement;
    for (const method of ["run", "get", "all", "iterate"] as const) {
      const original = statement[method].bind(statement) as (...args: unknown[]) => unknown;
      (statement as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
        seen.push(`${sql} ${JSON.stringify(args)}`);
        return original(...args);
      };
    }
    return statement;
  }) as typeof db.prepare);
  try {
    await work();
  } finally {
    spy.mockRestore();
  }
  return seen;
}

describe("a template's map, read from its folder", () => {
  it("answers the map and its layers to a member and an admin, by cookie and token, filed nowhere and never published", async () => {
    for (const headers of [byCookie(), byToken(), byAdminCookie()]) {
      const read = await call("GET", `/api/maps/${MAP}`, headers);
      expect(read.status).toBe(200);
      const map = read.body!;
      expect(map).toMatchObject({
        id: MAP, name: "Harbour stations", projectId: null, published: false, publishToken: null, publishedAt: null,
        customBasemap: null, lastChangedAt: null, lastChangedBy: null,
        viewport: { lng: -0.12, lat: 51.505, zoom: 12 },
        legendOrder: [DISTRICTS, STATIONS],
      });
      expect(map.editRevision).toMatch(/^[0-9a-f]{32}$/);
      expect((map.layers as { id: string; mapId: string; sql: string }[]).map((l) => [l.id, l.mapId, l.sql])).toEqual([
        [STATIONS, MAP, "SELECT * FROM stations"],
        [DISTRICTS, MAP, "SELECT * FROM districts"],
      ]);
      expect(map.widgets).toEqual([
        expect.objectContaining({ id: "widget-riders", type: "formula", layerId: STATIONS, field: "riders", agg: "sum" }),
        expect.objectContaining({ id: "widget-credit", type: "note", layerId: null, note: FIXTURE_CREDIT_NOTE }),
      ]);
      const layers = await call("GET", `/api/maps/${MAP}/layers`, headers);
      expect(layers.status).toBe(200);
      expect(layers.body).toEqual(map.layers);
      const layer = await call("GET", `/api/layers/${DISTRICTS}`, headers);
      expect(layer.status).toBe(200);
      expect(layer.body).toEqual((map.layers as unknown[])[1]);
    }
  });

  it("answers a missing version, a template id naming no map, and a layer the map lacks as missing", async () => {
    for (const route of [
      "/api/maps/template.harbour-stations.2.map",
      "/api/maps/template.no-such.1.map",
      `/api/maps/${STATIONS}`,
      "/api/maps/template.busy-stations.1.workflow",
      "/api/layers/template.harbour-stations.1.layer.layer-elsewhere",
      `/api/layers/${MAP}`,
    ]) {
      const read = await call("GET", route, byCookie());
      expect(read.status, route).toBe(404);
      expect(read.body, route).toMatchObject({ error: { code: "not_found" } });
    }
  });

  it("refuses an anonymous caller at the gate and the handler", async () => {
    const anonymous = (route: string) => socketRequest(new Request(`${ORIGIN}${route}`, { headers: { origin: ORIGIN } }));
    for (const [route, handler, id] of [
      [`/api/maps/${MAP}`, readMapRoute, MAP],
      [`/api/layers/${STATIONS}/render`, renderRoute, STATIONS],
    ] as const) {
      for (const response of [gateRequest(anonymous(route)), await handler(anonymous(route), { params: Promise.resolve({ id }) })]) {
        expect(response.status, route).toBe(401);
        expect((await response.json()).error.code, route).toBe("authentication_required");
      }
    }
  });
});

describe("the map's reader roads", () => {
  it("split a layer's live filters by the template map's own docked timeline, as a map's render does", async () => {
    await installFixture(D1, path.join(dataDir(), "templates", "docked-stations", "1"), { kind: "catalogue", origin: "https://catalogue.example" });
    const docked = "template.docked-stations.1.layer.layer-stations";
    const map = await call("GET", "/api/maps/template.docked-stations.1.map", byCookie());
    expect(map.body).toMatchObject({ timeline: { layerId: docked, field: "opened" } });
    // Docked, the time range ships to the canvas and every station is
    // drawn; read as undocked, it would be applied here, leaving two.
    const render = await call("GET", `/api/layers/${docked}/render`, byCookie());
    expect(render.body).toMatchObject({ ok: true, mode: "inline", featureCount: 6, liveFiltered: true });
  });

  it("render every layer inline, and answer the widgets, an extent and the search, the same by cookie and token", async () => {
    for (const headers of [byCookie(), byToken()]) {
      const stations = await call("GET", `/api/layers/${STATIONS}/render`, headers);
      expect(stations.status).toBe(200);
      expect(stations.body).toMatchObject({ layerId: STATIONS, ok: true, mode: "inline", featureCount: 6, geometryType: "POINT" });
      expect(featuresOf(stations.body).map((feature) => feature.properties.name)).toEqual(STATION_NAMES);
      const districts = await call("GET", `/api/layers/${DISTRICTS}/render`, headers);
      expect(districts.body).toMatchObject({ ok: true, mode: "inline", featureCount: 2, geometryType: "POLYGON" });

      const widgets = await call("POST", `/api/maps/${MAP}/widget-values`, headers, {});
      expect(widgets.status).toBe(200);
      expect(widgets.body).toEqual({
        widgets: [expect.objectContaining({ id: "widget-riders", value: RIDERS_TOTAL })],
        layers: [{ layerId: STATIONS, count: 6, total: 6 }],
      });

      const extent = await call("POST", `/api/layers/${STATIONS}/extent`, headers, {});
      expect(extent.status).toBe(200);
      expect(extent.body!.kind).toBe("extent");
      (extent.body!.box as number[]).forEach((value, i) => expect(value).toBeCloseTo(STATIONS_BOX[i], 6));

      const search = await call("GET", `/api/maps/${MAP}/search?q=harbour`, headers);
      expect(search.status).toBe(200);
      expect(search.body).toMatchObject({ layers: [], values: [{ layerId: STATIONS, field: "name", value: "Harbour" }] });
      const named = await call("GET", `/api/maps/${MAP}/search?q=districts`, headers);
      expect(named.body).toMatchObject({ layers: [{ layerId: DISTRICTS, name: "Districts" }] });
    }
  });

  it("draws a workflow example's map from its bundled results", async () => {
    const rings = await call("GET", `/api/layers/${RINGS}/render`, byCookie());
    expect(rings.body).toMatchObject({ ok: true, mode: "inline", featureCount: 4, geometryType: "POLYGON" });
    const busy = await call("GET", `/api/layers/${BUSY}/render`, byToken());
    expect(busy.body).toMatchObject({ ok: true, featureCount: 4, geometryType: "POINT" });
    expect(featuresOf(busy.body).map((feature) => feature.properties.name)).toEqual(["Harbour", "Market", "Bridge", "Docks"]);
    const widgets = await call("POST", `/api/maps/${W_MAP}/widget-values`, byToken(), {});
    expect(widgets.body).toMatchObject({ widgets: [{ id: "widget-riders", value: BUSY_TOTAL }], layers: [{ layerId: BUSY, count: 4, total: 4 }] });
  });

  it("are the map's generated tools, answering as the routes do", async () => {
    const byTool = async (name: string, args: Record<string, unknown>) => {
      const result = await executeTool(tool(name), args, ORIGIN, dispatch(memberToken));
      expect(result.status, name).toBe(200);
      return result.body;
    };
    expect(await byTool("get_map", { id: MAP })).toEqual((await call("GET", `/api/maps/${MAP}`, byToken())).body);
    expect(await byTool("render_layer", { id: STATIONS })).toEqual((await call("GET", `/api/layers/${STATIONS}/render`, byToken())).body);
    expect(await byTool("read_widget_values", { id: MAP })).toEqual((await call("POST", `/api/maps/${MAP}/widget-values`, byToken(), {})).body);
    expect(await byTool("layer_extent", { id: STATIONS })).toEqual((await call("POST", `/api/layers/${STATIONS}/extent`, byToken(), {})).body);
    expect(await byTool("search_map", { id: MAP, q: "harbour" })).toEqual((await call("GET", `/api/maps/${MAP}/search?q=harbour`, byToken())).body);
  });

  it("refuse a layer over the cap's default, placed by hand since the admission refuses it, at this instance's default cap", async () => {
    const crowded = await buildTemplate(path.join(dir, "o1"), { id: "crowded-stations", edit: SEEDS.layerOverRenderCap });
    await installFixture(crowded, path.join(dataDir(), "templates", "crowded-stations", "1"), { kind: "catalogue", origin: "https://catalogue.example" });
    const layer = "template.crowded-stations.1.layer.layer-stations";
    const render = await call("GET", `/api/layers/${layer}/render`, byCookie());
    expect(render.body).toMatchObject({ layerId: layer, ok: false, error: { code: "render_cap_exceeded" } });
    expect((render.body!.error as { message: string }).message).toBe(
      `This layer has ${(300_000).toLocaleString()} features, over the render cap of ${(250_000).toLocaleString()}. ` +
        "A template draws within the cap; make a copy to draw all of it.");
    expect(f.db.prepare("SELECT count(*) AS n FROM layer_tiles").get()).toEqual({ n: 0 });
    // Its other layer draws.
    expect((await call("GET", "/api/layers/template.crowded-stations.1.layer.layer-districts/render", byCookie())).body).toMatchObject({ ok: true });
  });

  it("over the render cap, refuse a template's point layer with the cap refusal and never build tiles", async () => {
    vi.stubEnv("DEZFIL_RENDER_CAP_FEATURES", "3");
    const render = await call("GET", `/api/layers/${STATIONS}/render`, byCookie());
    expect(render.status).toBe(200);
    expect(render.body).toMatchObject({ layerId: STATIONS, ok: false, error: { code: "render_cap_exceeded" } });
    expect((render.body!.error as { message: string }).message).toBe(
      "This layer has 6 features, over the render cap of 3. A template draws within the cap; make a copy to draw all of it.");
    expect(f.db.prepare("SELECT count(*) AS n FROM layer_tiles").get()).toEqual({ n: 0 });
    expect(await readdir(path.join(dataDir(), "tiles"), { recursive: true, withFileTypes: true })
      .then((entries) => entries.filter((entry) => entry.isFile()).map((entry) => entry.name)).catch(() => [])).toEqual([]);
    const tile = await call("GET", `/api/layers/${STATIONS}/tiles/0/0/0`, byCookie());
    expect(tile.status).toBe(404);
  });
});

/** The reader's roads, each with a body it accepts and the status a map's
 * own answers: a point layer takes no ephemeral selections on any map. */
const READER_ROADS: [string, string, unknown?, number?][] = [
  ["GET", `/api/maps/${MAP}`],
  ["GET", `/api/maps/${MAP}/layers`],
  ["POST", `/api/maps/${MAP}/widget-values`, {}],
  ["GET", `/api/maps/${MAP}/search?q=harbour`],
  // A template is never published: its publication reads as none.
  ["GET", `/api/maps/${MAP}/publish`, undefined, 204],
  ["GET", `/api/maps/${MAP}/published-fields`],
  ["GET", `/api/layers/${STATIONS}`],
  ["GET", `/api/layers/${STATIONS}/render`],
  ["POST", `/api/layers/${STATIONS}/render`, { selections: [] }, 400],
  ["POST", `/api/layers/${STATIONS}/extent`, {}],
  ["GET", `/api/layers/${STATIONS}/fields`],
  ["GET", `/api/layers/${STATIONS}/fields/riders`],
  ["GET", `/api/layers/${STATIONS}/slider-preview`],
  ["POST", `/api/layers/${STATIONS}/fill`, { attribute: "riders", method: "equal", classes: 3 }],
  ["POST", `/api/layers/${STATIONS}/scale`, { attribute: "riders", range: [2, 20] }],
];
const WRITE_ROADS: [string, string, unknown?][] = [
  ["PATCH", `/api/maps/${MAP}`, { name: "Renamed" }],
  ["DELETE", `/api/maps/${MAP}`],
  ["POST", `/api/maps/${MAP}/layers`, { name: "Added", sql: "SELECT * FROM stations" }],
  ["POST", `/api/maps/${MAP}/duplicate`, {}],
  ["POST", `/api/maps/${MAP}/publish`, {}],
  ["DELETE", `/api/maps/${MAP}/publish`],
  ["POST", `/api/maps/${MAP}/undo`, {}],
  ["POST", `/api/maps/${MAP}/redo`, {}],
  ["POST", `/api/maps/${MAP}/transfer`, { to: "admin" }],
  ["PUT", `/api/maps/${MAP}/thumbnail`],
  ["POST", `/api/maps/${MAP}/sketches`, { feature: { type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: {} } }],
  ["PATCH", `/api/layers/${STATIONS}`, { name: "Renamed" }],
  ["DELETE", `/api/layers/${STATIONS}`],
  ["POST", `/api/layers/${STATIONS}/duplicate`, {}],
];
/** Roads with nothing of a template's: history, dependencies, sketches,
 * snapshots, publication, published fields, tiles, exports, the look. */
const ABSENT_ROADS: [string, string, unknown?][] = [
  ["GET", `/api/maps/${MAP}/history`],
  ["GET", `/api/maps/${MAP}/dependencies`],
  ["GET", `/api/maps/${MAP}/sketches`],
  ["GET", `/api/maps/${MAP}/thumbnail`],
  ["POST", `/api/maps/${MAP}/export/image`, {}],
  ["POST", "/api/maps/look", { mapId: MAP }],
  ["GET", `/api/layers/${STATIONS}/tiles/0/0/0`],
  ["GET", `/api/layers/${STATIONS}/export/csv`],
  ["POST", "/api/query", { sql: "SELECT 1", writtenIn: { kind: "map", id: MAP } }],
];

describe("every road under a template's map and layer ids", () => {
  it("answers the reader's roads, refuses every write with the permission refusal and the rest as missing, and never asks the store by a template's id", async () => {
    const asked: string[] = [];
    let seen = 0;
    const road = async (method: string, route: string, body: unknown, status: number) => {
      let answer!: Awaited<ReturnType<typeof call>>;
      const statements = await statementsDuring(f.db, async () => {
        answer = await call(method, route, byCookie(), body);
      });
      seen += statements.length;
      asked.push(...statements.filter((statement) => TEMPLATE_ID.test(statement)).map((statement) => `${method} ${route}: ${statement}`));
      expect(answer.status, `${method} ${route}: ${answer.text}`).toBe(status);
      return answer;
    };
    for (const [method, route, body, status = 200] of READER_ROADS) await road(method, route, body, status);
    for (const [method, route, body] of WRITE_ROADS) {
      const answer = await road(method, route, body, 403);
      expect(answer.body, `${method} ${route}`).toEqual({ error: { code: "forbidden", message: PERMISSION_REFUSAL } });
    }
    for (const [method, route, body] of ABSENT_ROADS) await road(method, route, body, 404);
    // The spy saw the store: the reads it made carry the caller, never the template.
    expect(seen).toBeGreaterThan(0);
    expect(asked).toEqual([]);
  });

  it("changes nothing stored: the open and every road leave the documents, datasets, settings and data folder as they were", async () => {
    const before = await protectedState(f.db);
    const roads: [string, string, unknown, number][] = [
      ...READER_ROADS.map(([method, route, body, status = 200]): [string, string, unknown, number] => [method, route, body, status]),
      ...WRITE_ROADS.map(([method, route, body]): [string, string, unknown, number] => [method, route, body, 403]),
      ...ABSENT_ROADS.map(([method, route, body]): [string, string, unknown, number] => [method, route, body, 404]),
    ];
    for (const [method, route, body, status] of roads) {
      // Each road answered as it does, so a road that failed before it
      // could write is not read as one that wrote nothing.
      for (const headers of [byCookie(), byToken()]) expect((await call(method, route, headers, body)).status, `${method} ${route}`).toBe(status);
    }
    for (const [name, args] of [["get_map", { id: MAP }], ["render_layer", { id: STATIONS }], ["read_widget_values", { id: MAP }]] as const) {
      expect((await executeTool(tool(name), args, ORIGIN, dispatch(memberToken))).status, name).toBe(200);
    }
    expect(await protectedState(f.db)).toEqual(before);
  });
});

describe("a template's datasets", () => {
  it("answer a console query naming one as the console's unknown table, and its artifact by path as a file read", async () => {
    for (const headers of [byCookie(), byToken()]) {
      const named = await call("POST", "/api/query", headers, { sql: "SELECT * FROM stations" });
      expect(named.status).toBe(400);
      expect(named.body).toMatchObject({ error: { message: UNKNOWN_TABLE_MESSAGE } });
    }
    await call("GET", `/api/layers/${STATIONS}/render`, byCookie());
    const [artifact] = await templateArtifacts();
    const byPath = await call("POST", "/api/query", byCookie(), { sql: `SELECT * FROM '${artifact}'` });
    expect(byPath.status).toBe(400);
    expect(byPath.body).toMatchObject({ error: { code: "sql_rejected" } });
  });

  it("answer a person's layer naming one with that layer's refusal: the resource refusal naming it, or the home's own", async () => {
    // Read by a viewer of the map's project: the resource refusal names the reference.
    const viewer = await call("GET", `/api/layers/${ownLayer}/render`, byAdminCookie());
    expect(viewer.body).toMatchObject({ ok: false, error: { code: "sql_error", message: 'The dataset "stations" is not available to you.' } });
    // Read by its owner, whose home it binds in: the home's unknown-table refusal, as for any name it lacks.
    const owner = await call("GET", `/api/layers/${ownLayer}/render`, byCookie());
    expect(owner.body).toMatchObject({ ok: false, error: { code: "sql_error", message: UNKNOWN_TABLE_MESSAGE } });
  });

  it("are the only ones a template's layer binds: one naming the caller's own dataset is refused naming it", async () => {
    for (const headers of [byCookie(), byToken()]) {
      const render = await call("GET", `/api/layers/${STRAY_STATIONS}/render`, headers);
      expect(render.body).toMatchObject({ layerId: STRAY_STATIONS, ok: false, error: { code: "sql_error", message: 'The dataset "roads" is not available to you.' } });
    }
    const widgets = await call("POST", `/api/maps/${STRAY_MAP}/widget-values`, byCookie(), {});
    expect(widgets.body).toMatchObject({ widgets: [{ id: "widget-riders", errorCode: "sql_error" }] });
    // The same caller draws their own roads in their own home.
    expect((await call("POST", "/api/query", byCookie(), { sql: "SELECT sentinel FROM roads" })).body).toMatchObject({ preview: [{ sentinel: "member roads" }] });
  });

  it("are listed in no one's data: neither the data listing nor the catalogue read names one", async () => {
    await call("GET", `/api/layers/${STATIONS}/render`, byCookie());
    for (const route of ["/api/tables", "/api/catalogue/tables"]) {
      for (const headers of [byCookie(), byToken()]) {
        const listed = await call("GET", route, headers);
        expect(listed.status, route).toBe(200);
        // The listing holds the caller's own dataset, so a template's would show.
        expect(listed.text, route).toContain(roads.id);
        for (const name of ["stations", "districts", "busy_stations", "station_rings"]) expect(listed.text, `${route} ${name}`).not.toContain(`"${name}"`);
        expect(listed.text, route).not.toMatch(/template[.-]/);
      }
    }
  });

  it("show a seeded registration of a template's artifact in the listing, so the listing's check can fail", async () => {
    await call("GET", `/api/layers/${STATIONS}/render`, byCookie());
    const [artifact] = await templateArtifacts();
    insertTable(testAccountScope(f.db, "member"), {
      id: "seeded-registration", name: "stations", sourceFilename: null, format: "geoparquet", file: artifact,
      geometryColumn: "geom", geometryType: "POINT", crsAssumed: false, headerSuspect: false, rowCount: 6,
      createdAt: new Date().toISOString(), source: "upload", sourceParams: null, importedAt: null,
    }, f.db);
    const listed = await call("GET", "/api/tables", byCookie());
    expect(listed.text).toContain('"stations"');
  });
});
