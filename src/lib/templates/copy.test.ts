import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { POST as copyRoute } from "@/app/api/templates/[id]/copy/route";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { authenticateSession, createApiToken } from "@/lib/auth/credentials";
import { gateRequest } from "@/lib/auth/gate";
import { dataDir } from "@/lib/config";
import { resetQueryInstance } from "@/lib/duckdb";
import { accountFiles } from "@/lib/ingest/file-ownership";
import { ingestFile } from "@/lib/ingest/ingest";
import { testClient } from "@/lib/mcp/test-client";
import { recordCreationAttempt } from "../../../test-support/instance-limit-assistant";
import { instanceCounts } from "@/lib/instance-limits";
import { createProject } from "@/lib/metadata/owned-projects";
import { createMap } from "@/lib/map-service";
import * as mapThumbnails from "@/lib/map-thumbnails";
import { addStep, createRecipe } from "@/lib/metadata/recipes";
import * as tables from "@/lib/metadata/tables";
import { writeStoredSettings } from "@/lib/settings/store";
import { testAccountScope } from "@/lib/test-support/accounts";
import { imageInputs } from "@/lib/thumbnail-evidence";
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
import * as copyArtifacts from "./copy-artifacts";
import { setCopySeamForTests } from "./copy";
import { readInstalledVersion } from "./installed";
import * as shippedIndex from "./shipped-index";

/**
 * Making a copy of a map template: one new project of the copier's, private,
 * named as typed or after the template, a provenance line in its note; the
 * map filed in it with every layer, widget, the legend order and the camera
 * under fresh identities and bound to the copied layers; every dataset the
 * copier's under the template's name or the next free one, its source
 * `template` with the id and version, each layer's SQL naming the dataset as
 * landed; the card images the template's pictures, saved after the commit
 * with evidence naming the copied datasets. All of it or nothing: a failure
 * anywhere before the commit leaves nothing of the copier's and keeps the
 * download. Read through the real routes, by cookie, token and tool.
 *
 * Three installed versions: a map template shipped in the image, another
 * downloaded, and a downloaded one whose layer names a dataset of no
 * template's, placed by hand since the admission would refuse it.
 */

const ORIGIN = "http://instance.test";
const TODAY = () => new Date().toISOString().slice(0, 10);
const RIDERS_TOTAL = 340 + 220 + 180 + 90 + 60 + 410;
const LOCAL_NAME_SQL = "WITH stations_2 AS (SELECT 99 AS x) SELECT * FROM stations";
const QUALIFIED_SQL = "SELECT stations.id, stations.name, stations.riders, stations.opened, stations.geom FROM stations WHERE stations.riders > 0";
const SCHEMA_SQL = "SELECT main.stations.geom FROM main.stations";
const SCHEMA_COLUMN_SQL = "SELECT main.stations.geom FROM stations";
const SCHEMA_ROW_SQL = "SELECT * FROM stations WHERE main.stations IS NOT NULL";

let built: string;
let M1: BuiltTemplate, Q1: BuiltTemplate, X1: BuiltTemplate, D1: BuiltTemplate, N1: BuiltTemplate, L1: BuiltTemplate;
let T1: BuiltTemplate, S1: BuiltTemplate, S2: BuiltTemplate, S3: BuiltTemplate;
let f: ReturnType<typeof instanceSettingsFixture>;
let dir: string;
let shippedFolder: string;
let downloadFolder: string;
let memberToken: string;
let ownHome: string;

beforeAll(async () => {
  built = await mkdtemp(path.join(process.cwd(), ".tmp-test-template-copy-"));
  M1 = await buildTemplate(path.join(built, "m1"), { id: "harbour-stations" });
  Q1 = await buildTemplate(path.join(built, "q1"), { id: "quiet-park", title: "Quiet park" });
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
  // The stations layer qualifying every column by the dataset's own name.
  N1 = await buildTemplate(path.join(built, "n1"), {
    id: "named-columns",
    edit: (files) => {
      const layers = files.documents.get("maps/map.json")!.layers as Record<string, unknown>[];
      layers.find((layer) => layer.id === "layer-stations")!.sql = QUALIFIED_SQL;
    },
  });
  // The stations layer defining a query-local name of the shape a second
  // copy's dataset would take.
  L1 = await buildTemplate(path.join(built, "l1"), {
    id: "local-names",
    edit: (files) => {
      const layers = files.documents.get("maps/map.json")!.layers as Record<string, unknown>[];
      layers.find((layer) => layer.id === "layer-stations")!.sql = LOCAL_NAME_SQL;
    },
  });
  // The stations layer reading its dataset through a table function's
  // listed argument, placed by hand since the admission refuses it.
  T1 = await buildTemplate(path.join(built, "t1"), { id: "listed-name", edit: SEEDS.layerListedName });
  // The stations layer qualifying a column by its dataset's schema, the
  // dataset itself qualified or plain; placed by hand, since the admission
  // refuses both.
  const stationsSql = (id: string, sql: string) => buildTemplate(path.join(built, id), {
    id,
    edit: (files) => {
      const layers = files.documents.get("maps/map.json")!.layers as Record<string, unknown>[];
      layers.find((layer) => layer.id === "layer-stations")!.sql = sql;
    },
  });
  S1 = await stationsSql("schema-names", SCHEMA_SQL);
  S2 = await stationsSql("schema-columns", SCHEMA_COLUMN_SQL);
  // Two parts in a column's place name the dataset's whole row.
  S3 = await stationsSql("schema-rows", SCHEMA_ROW_SQL);
});
afterAll(async () => { await rm(built, { recursive: true, force: true }); });

beforeEach(async () => {
  f = instanceSettingsFixture();
  resetQueryInstance();
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-template-copy-run-"));
  const shipped = await writeShippedFolder(path.join(dir, "shipped"), [M1]);
  shippedFolder = path.join(shipped, "harbour-stations", "1");
  vi.spyOn(shippedIndex, "shippedTemplatesDir").mockReturnValue(shipped);
  const downloads = path.join(dataDir(), "templates");
  downloadFolder = path.join(downloads, "quiet-park", "1");
  await installFixture(Q1, downloadFolder, { kind: "catalogue", origin: "https://catalogue.example" });
  await installFixture(X1, path.join(downloads, "stray-roads", "1"), { kind: "catalogue", origin: "https://catalogue.example" });
  memberToken = createApiToken(authenticateSession(f.member.secret, f.db)!, "Member", f.db).secret;
  ownHome = (await call("GET", `/api/maps/${createMap(testAccountScope(f.db, "member"), "Own").id}`, byCookie())).body!.home as string;
});
afterEach(async () => {
  setCopySeamForTests(null);
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
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  })));
  const text = await response.text();
  const json = response.headers.get("content-type")?.includes("json") && text ? JSON.parse(text) : null;
  return { status: response.status, headers: response.headers, body: json as Record<string, unknown> | null, text };
}

const copy = (id: string, headers: Headers = byCookie(), body?: unknown) => call("POST", `/api/templates/${id}/copy`, headers, body);

interface Copied {
  project: { id: string; name: string; note: string | null; role: string; mapCount: number; recipeCount: number; tableCount: number };
  members: {
    maps: { id: string; name: string }[];
    recipes: unknown[];
    tables: { id: string; name: string; source: string; sourceParams: Record<string, unknown> | null }[];
  };
}
type MapRead = {
  id: string; name: string; home: string; owner: { name: string }; projectId: string | null; published: boolean;
  viewport: unknown; legendOrder: string[] | null; widgetsPublished: boolean;
  timeline: { layerId: string; field: string } | null;
  widgets: { id: string; type: string; layerId: string | null; note: string | null }[];
  layers: { id: string; name: string; sql: string; style: unknown }[];
};

async function landed(response: Awaited<ReturnType<typeof copy>>): Promise<Copied & { map: MapRead }> {
  expect(response.status, response.text).toBe(201);
  const body = response.body as unknown as Copied;
  const map = (await call("GET", `/api/maps/${body.members.maps[0].id}`, byCookie())).body as unknown as MapRead;
  return { ...body, map };
}

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const names = (copied: Copied) => copied.members.tables.map((t) => t.name).sort();
const layerSql = (map: MapRead) => Object.fromEntries(map.layers.map((l) => [l.name, l.sql]));

/** Every file of the data folder's `tables/`, by name, with its checksum. */
async function tableFiles(): Promise<Record<string, string>> {
  const folder = path.join(dataDir(), "tables");
  const out: Record<string, string> = {};
  for (const name of (await readdir(folder).catch(() => [])).sort()) out[name] = sha(await readFile(path.join(folder, name)));
  return out;
}

/** Every file under a folder, relative, with its checksum. */
async function folderHashes(folder: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (at: string, prefix: string) => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(at, entry.name), relative);
      else out[relative] = sha(await readFile(path.join(at, entry.name)));
    }
  };
  await walk(folder, "");
  return out;
}

/** What an account holds in the store: projects, maps with their layers,
 * workflows and datasets, as rows. */
function holdings(db: Database, owner: string) {
  const rows = (sql: string) => JSON.stringify(db.prepare(sql).all(owner));
  return {
    projects: rows("SELECT * FROM projects WHERE owner_id = ? ORDER BY id"),
    maps: rows("SELECT * FROM maps WHERE owner_id = ? ORDER BY id"),
    layers: rows("SELECT l.* FROM layers l JOIN maps m ON m.id = l.map_id WHERE m.owner_id = ? ORDER BY l.id"),
    recipes: rows("SELECT * FROM recipes WHERE owner_id = ? ORDER BY id"),
    tables: rows("SELECT * FROM data_tables WHERE owner_id = ? ORDER BY id"),
  };
}

const count = (db: Database, table: string, owner: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_id = ?`).get(owner) as { n: number }).n;

/** The copy of one copy: its documents and its datasets' rows and files,
 * and its card images. */
async function snapshot(copied: Copied & { map: MapRead }) {
  const map = (await call("GET", `/api/maps/${copied.map.id}`, byCookie())).body;
  const rows = copied.members.tables.map((t) => f.db.prepare("SELECT * FROM data_tables WHERE id = ?").get(t.id) as { file: string });
  const files = await Promise.all(rows.map(async (row) => sha(await readFile(path.join(dataDir(), row.file)))));
  const project = f.db.prepare("SELECT * FROM projects WHERE id = ?").get(copied.project.id);
  const thumbnails = await folderHashes(path.join(dataDir(), "thumbnails")).catch(() => ({}));
  const own = Object.fromEntries(Object.entries(thumbnails).filter(([name]) => name.startsWith(copied.map.id)));
  return JSON.stringify({ map, rows, files, project, own });
}

async function renders(layerId: string) {
  const render = await call("GET", `/api/layers/${layerId}/render`, byCookie());
  expect(render.status).toBe(200);
  return render.body as { ok: boolean; mode: string; featureCount: number; geometryType: string };
}

describe("a copy of a map template", () => {
  it("lands whole: the project with its provenance, the map under fresh identities with everything bound to its own layers, the datasets as the template's, every layer drawing, the card images evidenced", async () => {
    const folderBefore = await folderHashes(shippedFolder);
    const response = await copy("harbour-stations");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const copied = await landed(response);
    expect(response.headers.get("location")).toBe(`/api/projects/${copied.project.id}`);

    expect(copied.project).toMatchObject({
      name: "Harbour stations",
      note: `Copied from the template Harbour stations, version 1, on ${TODAY()}.`,
      role: "owner", mapCount: 1, recipeCount: 0, tableCount: 2,
    });
    expect(names(copied)).toEqual(["districts", "stations"]);
    for (const table of copied.members.tables) {
      expect(table).toMatchObject({ source: "template", sourceParams: { template: "harbour-stations", version: 1 } });
      const row = f.db.prepare("SELECT owner_id, file FROM data_tables WHERE id = ?").get(table.id) as { owner_id: string; file: string };
      expect(row.owner_id).toBe("member");
      expect(row.file).toBe(`tables/${table.id}.parquet`);
      expect(sha(await readFile(path.join(dataDir(), row.file)))).toBe(sha(M1.files.binaries.get(`datasets/${table.name}.parquet`)!));
    }
    // Every dataset filed in the project, and nothing else of the copier's
    // under the artifact directory.
    expect(Object.keys(await tableFiles()).sort()).toEqual(copied.members.tables.map((t) => `${t.id}.parquet`).sort());

    const { map } = copied;
    expect(map).toMatchObject({ name: "Harbour stations", owner: { name: "member" }, home: ownHome, projectId: copied.project.id,
      published: false, widgetsPublished: true, viewport: { lng: -0.12, lat: 51.505, zoom: 12 } });
    const stations = map.layers.find((l) => l.name === "Stations")!;
    const districts = map.layers.find((l) => l.name === "Districts")!;
    expect(layerSql(map)).toEqual({ Stations: "SELECT * FROM stations", Districts: "SELECT * FROM districts" });
    for (const layer of map.layers) {
      expect(layer.id).not.toMatch(/^template\.|^layer-/);
    }
    const templateLayers = (M1.files.documents.get("maps/map.json")!.layers as { id: string; style: unknown }[]);
    expect(stations.style).toEqual(templateLayers.find((l) => l.id === "layer-stations")!.style);
    expect(map.legendOrder).toEqual([districts.id, stations.id]);
    expect(map.widgets.map((w) => [w.type, w.layerId])).toEqual([["formula", stations.id], ["note", null]]);
    expect(map.widgets.find((w) => w.type === "note")!.note).toBe(FIXTURE_CREDIT_NOTE);
    for (const widget of map.widgets) expect(["widget-riders", "widget-credit"]).not.toContain(widget.id);

    expect(await renders(stations.id)).toMatchObject({ ok: true, mode: "inline", featureCount: 6, geometryType: "POINT" });
    expect(await renders(districts.id)).toMatchObject({ ok: true, mode: "inline", featureCount: 2, geometryType: "POLYGON" });
    const widgets = await call("POST", `/api/maps/${map.id}/widget-values`, byCookie(), {});
    expect(widgets.body).toMatchObject({ widgets: [expect.objectContaining({ value: RIDERS_TOTAL })] });

    // The card images: the template's pictures, published as the map's
    // themed pair marked as the template's, each with evidence naming the
    // copied datasets.
    const manifest = JSON.parse(await readFile(mapThumbnails.thumbnailManifestPath(map.id), "utf8")) as Record<"light" | "dark", string>;
    expect(await mapThumbnails.publishedPictureFormat(map.id)).toEqual({ sized: false, recipe: 0, template: true });
    for (const theme of ["light", "dark"] as const) {
      const bytes = await readFile(path.join(dataDir(), "thumbnails", manifest[theme]));
      expect(sha(bytes)).toBe(sha(M1.files.binaries.get(`pictures/${theme}.png`)!));
      const evidence = await imageInputs(manifest[theme], bytes);
      expect(evidence?.datasets.map((d) => d.id).sort()).toEqual(copied.members.tables.map((t) => t.id).sort());
      expect(sha((await mapThumbnails.readThumbnail(testAccountScope(f.db, "member"), map.id, theme))!)).toBe(sha(bytes));
    }

    expect(await folderHashes(shippedFolder)).toEqual(folderBefore);
  });

  it("docks the copy's timeline to the copied layer, whose render splits its live filters by it as the template's does", async () => {
    await installFixture(D1, path.join(dataDir(), "templates", "docked-stations", "1"), { kind: "catalogue", origin: "https://catalogue.example" });
    const { map } = await landed(await copy("docked-stations"));
    const stations = map.layers.find((l) => l.name === "Stations")!;
    expect(stations.id).not.toBe("layer-stations");
    expect(map.timeline).toMatchObject({ layerId: stations.id, field: "opened" });
    // Docked, the time range ships to the canvas and every station is
    // drawn; a timeline naming any other layer leaves the range applied
    // here, drawing the two stations opened since 2021.
    expect(await renders(stations.id)).toMatchObject({ ok: true, mode: "inline", featureCount: 6, liveFiltered: true });
  });

  it("a copied dataset is never refreshed: it came from no source to read again", async () => {
    const copied = await landed(await copy("harbour-stations"));
    const before = await tableFiles();
    const refresh = await call("POST", "/api/tables/stations/refresh", byCookie(), {});
    expect(refresh.status).toBe(409);
    expect(refresh.body!.error).toMatchObject({ code: "not_refreshable", message: expect.stringContaining("copied from a template") });
    expect(await tableFiles()).toEqual(before);
    expect(copied.members.tables.every((t) => t.source === "template")).toBe(true);
  });

  it("names the project as typed", async () => {
    const copied = await landed(await copy("harbour-stations", byCookie(), { name: "  My harbour  " }));
    expect(copied.project.name).toBe("My harbour");
  });

  it("a second copy is a second project of the same name, its datasets suffixed and its documents naming them, the first copy unchanged", async () => {
    const first = await landed(await copy("harbour-stations"));
    const before = await snapshot(first);
    const second = await landed(await copy("harbour-stations"));
    expect(second.project.id).not.toBe(first.project.id);
    expect(second.project.name).toBe(first.project.name);
    expect(names(second)).toEqual(["districts_2", "stations_2"]);
    expect(layerSql(second.map)).toEqual({ Stations: "SELECT * FROM stations_2 AS stations", Districts: "SELECT * FROM districts_2 AS districts" });
    expect(new Set([...first.map.layers, ...second.map.layers].map((l) => l.id)).size).toBe(4);
    expect(await renders(second.map.layers.find((l) => l.name === "Stations")!.id)).toMatchObject({ ok: true, featureCount: 6 });
    expect(await snapshot(first)).toBe(before);
  });

  it("a layer qualifying its columns by its dataset's name draws when the dataset lands under another name, which it binds by the old one", async () => {
    await installFixture(N1, path.join(dataDir(), "templates", "named-columns", "1"), { kind: "catalogue", origin: "https://catalogue.example" });
    const first = await landed(await copy("named-columns"));
    expect(layerSql(first.map).Stations).toBe(QUALIFIED_SQL);
    // The second copy finds "stations" taken by the first.
    const second = await landed(await copy("named-columns"));
    expect(names(second)).toEqual(["districts_2", "stations_2"]);
    const stations = second.map.layers.find((l) => l.name === "Stations")!;
    expect(await renders(stations.id)).toMatchObject({ ok: true, mode: "inline", featureCount: 6, geometryType: "POINT" });
    expect(stations.sql).toBe(QUALIFIED_SQL.replace("FROM stations", "FROM stations_2 AS stations"));
    // It reads the second copy's own dataset: the rows the copied file holds.
    const widgets = await call("POST", `/api/maps/${second.map.id}/widget-values`, byCookie(), {});
    expect(widgets.body).toMatchObject({ widgets: [expect.objectContaining({ value: RIDERS_TOTAL })] });
  });

  it("never lands a dataset under a name the template's queries define for themselves: a second copy reads its own dataset", async () => {
    await installFixture(L1, path.join(dataDir(), "templates", "local-names", "1"), { kind: "catalogue", origin: "https://catalogue.example" });
    const first = await landed(await copy("local-names"));
    expect(names(first)).toEqual(["districts", "stations"]);
    expect(layerSql(first.map).Stations).toBe(LOCAL_NAME_SQL);
    // The second copy finds "stations" taken, and "stations_2" is the
    // query's own name: the dataset lands past it.
    const second = await landed(await copy("local-names"));
    const stations = second.map.layers.find((l) => l.name === "Stations")!;
    expect(await renders(stations.id)).toMatchObject({ ok: true, mode: "inline", featureCount: 6, geometryType: "POINT" });
    const widgets = await call("POST", `/api/maps/${second.map.id}/widget-values`, byCookie(), {});
    expect(widgets.body).toMatchObject({ widgets: [expect.objectContaining({ value: RIDERS_TOTAL })] });
    expect(names(second)).toEqual(["districts_2", "stations_3"]);
    expect(stations.sql).toBe("WITH stations_2 AS (SELECT 99 AS x) SELECT * FROM stations_3 AS stations");
  });

  it("a copier whose workflow declares a template dataset's name lands that dataset under the next free name", async () => {
    const member = testAccountScope(f.db, "member");
    const recipe = createRecipe(member, "Mine", f.db);
    addStep(recipe.id, { operation: "sql_step", parameters: { sql: "SELECT 1 AS one", name: "stations" } }, f.db);
    const copied = await landed(await copy("harbour-stations"));
    expect(names(copied)).toEqual(["districts", "stations_2"]);
    expect(layerSql(copied.map)).toEqual({ Stations: "SELECT * FROM stations_2 AS stations", Districts: "SELECT * FROM districts" });
    expect(await renders(copied.map.layers.find((l) => l.name === "Stations")!.id)).toMatchObject({ ok: true, featureCount: 6 });
  });

  it("two accounts copying at once each land whole under the plain names, each one's documents naming its own", async () => {
    const [mine, theirs] = await Promise.all([copy("harbour-stations"), copy("harbour-stations", byAdminCookie())]);
    const member = await landed(mine);
    expect(theirs.status, theirs.text).toBe(201);
    const admin = theirs.body as unknown as Copied;
    expect(names(member)).toEqual(["districts", "stations"]);
    expect(names(admin)).toEqual(["districts", "stations"]);
    const owners = (copied: Copied) => copied.members.tables.map((t) => (f.db.prepare("SELECT owner_id FROM data_tables WHERE id = ?").get(t.id) as { owner_id: string }).owner_id);
    expect(owners(member)).toEqual(["member", "member"]);
    expect(owners(admin)).toEqual(["admin", "admin"]);
    const adminMap = (await call("GET", `/api/maps/${admin.members.maps[0].id}`, byAdminCookie())).body as unknown as MapRead;
    expect(adminMap.home).not.toBe(member.map.home);
    for (const [map, headers] of [[member.map, byCookie()], [adminMap, byAdminCookie()]] as const) {
      const stations = map.layers.find((l) => l.name === "Stations")!;
      const render = await call("GET", `/api/layers/${stations.id}/render`, headers);
      expect(render.body).toMatchObject({ ok: true, featureCount: 6 });
    }
  });

  it("two copies at once by one account, both held before their transaction, land under distinct names, the account's earlier work unchanged", async () => {
    const member = testAccountScope(f.db, "member");
    const csv = path.join(dir, "roads.csv");
    await writeFile(csv, "name,lon,lat\nmember road,1,2\n");
    await ingestFile(member, csv, "roads.csv");
    const earlier = holdings(f.db, "member");
    const earlierFiles = await tableFiles();

    // Both copies wait at the step before their transaction until both are
    // there: each has copied its files and planned nothing it could share.
    const arrived: string[] = [];
    const both = Promise.withResolvers<void>();
    setCopySeamForTests({
      async beforeTransaction(key) {
        arrived.push(key);
        if (arrived.length === 2) both.resolve();
        await both.promise;
      },
    });
    const [a, b] = await Promise.all([copy("harbour-stations"), copy("harbour-stations")]);
    expect(arrived).toEqual(["harbour-stations@1", "harbour-stations@1"]);
    const one = await landed(a);
    const two = await landed(b);
    expect([names(one), names(two)].sort()).toEqual([["districts", "stations"], ["districts_2", "stations_2"]]);
    for (const copied of [one, two]) {
      const own = new Set(names(copied));
      for (const sql of Object.values(layerSql(copied.map))) expect(own.has(sql.replace("SELECT * FROM ", "").split(" ")[0])).toBe(true);
      expect(await renders(copied.map.layers.find((l) => l.name === "Stations")!.id)).toMatchObject({ ok: true, featureCount: 6 });
    }
    // The earlier rows and files exactly as they were.
    const now = holdings(f.db, "member");
    for (const kind of ["maps", "recipes"] as const) {
      const before = JSON.parse(earlier[kind]) as { id: string }[];
      const after = (JSON.parse(now[kind]) as { id: string }[]).filter((row) => before.some((b) => b.id === row.id));
      expect(after).toEqual(before);
    }
    const beforeTables = JSON.parse(earlier.tables) as { id: string }[];
    expect((JSON.parse(now.tables) as { id: string }[]).filter((row) => beforeTables.some((b) => b.id === row.id))).toEqual(beforeTables);
    const files = await tableFiles();
    for (const [name, hash] of Object.entries(earlierFiles)) expect(files[name]).toBe(hash);
  });
});

describe("all or nothing", () => {
  const nothingOfTheCopiers = async () => {
    for (const table of ["projects", "maps", "recipes", "data_tables"]) expect(count(f.db, table, "member"), table).toBe(table === "maps" ? 1 : 0);
    expect(await tableFiles()).toEqual({});
    expect(accountFiles("member")).toEqual([]);
  };

  it("a failure copying the last dataset's file leaves no file and nothing of the copier's, and the download stays", async () => {
    const real = copyArtifacts.copyDatasetFile;
    let calls = 0;
    // The last file's bytes differ from what its record says: written,
    // found wrong, removed.
    vi.spyOn(copyArtifacts, "copyDatasetFile").mockImplementation((account, folder, member, sha256) =>
      real(account, folder, member, ++calls === 2 ? "0".repeat(64) : sha256));
    const response = await copy("quiet-park");
    expect(calls).toBe(2);
    expect(response.status).toBe(422);
    expect(response.body).toEqual({ error: { code: "template_record_mismatch", message: expect.any(String) } });
    await nothingOfTheCopiers();
    await expect(readInstalledVersion(downloadFolder)).resolves.toMatchObject({ record: { id: "quiet-park", version: 1 } });
  });

  it("a failure registering the last dataset, inside the transaction after the project that opens it, leaves no project and no file, and the download stays", async () => {
    const real = tables.insertTable;
    let calls = 0;
    vi.spyOn(tables, "insertTable").mockImplementation((scope, table, db) => {
      if (++calls === 2) throw new Error("seeded registration failure");
      return real(scope, table, db);
    });
    const response = await copy("quiet-park");
    expect(calls).toBe(2);
    expect(response.status).toBe(500);
    await nothingOfTheCopiers();
    await expect(readInstalledVersion(downloadFolder)).resolves.toMatchObject({ record: { id: "quiet-park", version: 1 } });
  });

  it("an account deletion accepted while the copy waits for its transaction stops it, with nothing registered and its files removed", async () => {
    setCopySeamForTests({
      beforeTransaction() {
        f.db.prepare("UPDATE accounts SET status = 'deleting' WHERE id = 'member'").run();
      },
    });
    const response = await copy("harbour-stations");
    expect(response.status).toBeGreaterThanOrEqual(400);
    for (const table of ["projects", "recipes", "data_tables"]) expect(count(f.db, table, "member"), table).toBe(0);
    expect(await tableFiles()).toEqual({});
    expect(accountFiles("member")).toEqual([]);
  });

  it("a card image that cannot be saved leaves the copy whole, its card on the placeholder", async () => {
    vi.spyOn(mapThumbnails, "saveThemedThumbnail").mockRejectedValue(new Error("seeded picture failure"));
    const copied = await landed(await copy("harbour-stations"));
    expect(copied.project.tableCount).toBe(2);
    expect(copied.map.layers).toHaveLength(2);
    expect(await mapThumbnails.readThumbnail(testAccountScope(f.db, "member"), copied.map.id)).toBeNull();
    expect(await renders(copied.map.layers[0].id)).toMatchObject({ ok: true });
  });
});

describe("what a copy refuses", () => {
  it("a version neither installed nor listed, an unknown template, a shipped template's other version and a reference the copy cannot bind, each coded with nothing created", async () => {
    for (const [id, body, status, code] of [
      ["harbour-stations", { version: 2 }, 404, "template_not_listed"],
      ["quiet-park", { version: 3 }, 404, "template_not_listed"],
      ["no-such", undefined, 404, "template_not_listed"],
      ["Not An Id", undefined, 404, "template_not_listed"],
      ["stray-roads", undefined, 422, "template_reference_unbound"],
    ] as const) {
      const response = await copy(id, byCookie(), body);
      expect(response.status, id).toBe(status);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.body, id).toEqual({ error: { code, message: expect.any(String) } });
    }
    expect((await copy("stray-roads")).body!.error).toMatchObject({ message: expect.stringContaining('"roads"') });
    for (const table of ["projects", "recipes", "data_tables"]) expect(count(f.db, table, "member"), table).toBe(0);
    expect(await tableFiles()).toEqual({});
  });

  it("a layer reading its dataset by a name the rewrite cannot reach, once that dataset lands under another name, though the text is unchanged, with nothing created", async () => {
    await installFixture(T1, path.join(dataDir(), "templates", "listed-name", "1"), { kind: "catalogue", origin: "https://catalogue.example" });
    // Under the plain names the template's text reads what it read.
    const first = await landed(await copy("listed-name"));
    expect(names(first)).toEqual(["districts", "stations"]);
    expect(layerSql(first.map).Stations).toBe("SELECT * FROM query_table(['stations'])");
    expect(await renders(first.map.layers.find((l) => l.name === "Stations")!.id)).toMatchObject({ ok: true, featureCount: 6 });
    const before = holdings(f.db, "member");
    const files = await tableFiles();
    // "stations" is the first copy's now: a second copy's dataset would
    // land as "stations_2" while its layer went on reading the first's.
    const second = await copy("listed-name");
    expect(second.status, second.text).toBe(422);
    expect(second.body).toEqual({ error: {
      code: "template_reference_unbound",
      message: 'The map\'s layer 1 ("Stations") could not be bound to the datasets the copy makes, so nothing was created.',
    } });
    expect(holdings(f.db, "member")).toEqual(before);
    expect(await tableFiles()).toEqual(files);
  });

  it.each([["schema-names", SCHEMA_SQL], ["schema-columns", SCHEMA_COLUMN_SQL], ["schema-rows", SCHEMA_ROW_SQL]] as const)(
    "a layer qualifying a column by its dataset's schema (%s), once that dataset lands under another name, with nothing created",
    async (id, sql) => {
      await installFixture({ "schema-names": S1, "schema-columns": S2, "schema-rows": S3 }[id], path.join(dataDir(), "templates", id, "1"), { kind: "catalogue", origin: "https://catalogue.example" });
      // Under the plain names the template's text reads what it read.
      const first = await landed(await copy(id));
      expect(layerSql(first.map).Stations).toBe(sql);
      expect(await renders(first.map.layers.find((l) => l.name === "Stations")!.id)).toMatchObject({ ok: true, featureCount: 6 });
      const before = holdings(f.db, "member");
      const files = await tableFiles();
      // The second copy's dataset lands as "stations_2", bound by the old
      // name as an alias: "main.stations" names no table of its text.
      const second = await copy(id);
      expect(second.status, second.text).toBe(422);
      expect(second.body).toEqual({ error: {
        code: "template_reference_unbound",
        message: 'The map\'s layer 1 ("Stations") could not be bound to the datasets the copy makes, so nothing was created.',
      } });
      expect(holdings(f.db, "member")).toEqual(before);
      expect(await tableFiles()).toEqual(files);
    },
  );

  it("a body that is not a name and a version, and one past its bound", async () => {
    for (const body of [{ name: "" }, { name: 5 }, { name: "x".repeat(121) }, { version: "1" }, { version: 0 }, { other: 1 }, "[1]", "{ not json"]) {
      const response = await copy("harbour-stations", byCookie(), body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.body!.error, JSON.stringify(body)).toMatchObject({ code: "invalid_request" });
    }
    const large = await copy("harbour-stations", byCookie(), { name: "x", padding: "x".repeat(70_000) });
    expect(large.status).toBe(413);
    expect(count(f.db, "projects", "member")).toBe(0);
  });

  it("copies an installed version with the catalogue off, since the copy is local", async () => {
    writeStoredSettings({ "templates.catalogue": false }, f.db);
    expect(names(await landed(await copy("harbour-stations")))).toEqual(["districts", "stations"]);
    const downloaded = await landed(await copy("quiet-park", byCookie(), { version: 1 }));
    expect(downloaded.members.tables[0].sourceParams).toEqual({ template: "quiet-park", version: 1 });
  });
});

describe("by cookie, token and tool", () => {
  const shape = (body: unknown) => {
    const copied = body as Copied;
    return { name: copied.project.name, tables: names(copied), maps: copied.members.maps.map((m) => m.name) };
  };

  it("answers the same by cookie, token and the generated tool", async () => {
    const byCookieCopy = await copy("harbour-stations");
    const byTokenCopy = await copy("harbour-stations", byToken());
    expect(byTokenCopy.status).toBe(201);
    const tool = buildTools().find((t) => t.name === "copy_template")!;
    const byTool = await executeTool(tool, { id: "harbour-stations" }, ORIGIN, (async (input: RequestInfo | URL, init?: RequestInit) => {
      const incoming = input instanceof Request ? input : new Request(String(input), init);
      const headers = new Headers(incoming.headers);
      headers.set("authorization", `Bearer ${memberToken}`);
      return dispatchAssistantTestRoute(socketRequest(new Request(incoming, { headers })));
    }) as typeof fetch);
    expect(byTool.ok).toBe(true);
    expect(shape(byCookieCopy.body)).toEqual({ name: "Harbour stations", tables: ["districts", "stations"], maps: ["Harbour stations"] });
    expect(shape(byTokenCopy.body)).toEqual({ name: "Harbour stations", tables: ["districts_2", "stations_2"], maps: ["Harbour stations"] });
    expect(shape(byTool.body)).toEqual({ name: "Harbour stations", tables: ["districts_3", "stations_3"], maps: ["Harbour stations"] });
  });

  it("refuses an anonymous request at the gate and the handler, and a cookie from another origin, creating nothing", async () => {
    const anonymous = () => socketRequest(new Request(`${ORIGIN}/api/templates/harbour-stations/copy`, { method: "POST", headers: { origin: ORIGIN } }));
    expect(gateRequest(anonymous()).status).toBe(401);
    const handled = await copyRoute(anonymous(), { params: Promise.resolve({ id: "harbour-stations" }) });
    expect(handled.status).toBe(401);
    expect(await handled.json()).toEqual({ error: { code: "authentication_required", message: expect.any(String) } });
    const elsewhere = await copy("harbour-stations", { cookie: `dezfil_session=${f.member.secret}`, origin: "https://elsewhere.test" });
    expect(elsewhere.status).toBe(403);
    expect(count(f.db, "projects", "member")).toBe(0);
    expect(await tableFiles()).toEqual({});
  });
});


it.each(["mapsLimit", "projectsLimit"])("refuses a template copy at %s through session, token and tool, retaining only its installation", async key => {
  createProject(testAccountScope(f.db, "member"), { name: "Existing" }, f.db);
  const before = instanceCounts(f.db), files = await tableFiles(), installed = await folderHashes(shippedFolder);
  expect(before).toEqual({ maps: 1, projects: 1, people: 2 });
  writeStoredSettings({ [key]: 1 }, f.db);
  for (const headers of [byCookie(), byToken()]) {
    const response = await copy("harbour-stations", headers);
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: { code: "instance_limit_reached", key, limit: 1, count: 1 } });
  }
  const tool = buildTools().find(t => t.name === "copy_template")!;
  const result = await executeTool(tool, { id: "harbour-stations" }, ORIGIN,
    (input, init) => dispatchAssistantTestRoute(new Request(input, init)), byToken());
  expect(result).toMatchObject({ status: 409, body: { error: { code: "instance_limit_reached", key, limit: 1, count: 1 } } });
  const client = await testClient(request => {
    request.headers.set("authorization", `Bearer ${memberToken}`);
    return dispatchAssistantTestRoute(request);
  });
  try {
    const mcp = await client.callTool({ name: "copy_template", arguments: { id: "harbour-stations" } });
    expect(mcp.isError).toBe(true);
    expect(mcp.structuredContent).toMatchObject({ result: result.body });
  } finally { await client.close(); }
  const assistant = await recordCreationAttempt(testAccountScope(f.db, "member"), authenticateSession(f.member.secret, f.db)!, "copy_template", { id: "harbour-stations" });
  expect(assistant.actions).toMatchObject([{ tool: "copy_template", status: "refused" }]);
  expect(assistant.outcome).toEqual(result.body);
  expect(instanceCounts(f.db)).toEqual(before);
  expect(await tableFiles()).toEqual(files);
  expect(await folderHashes(shippedFolder)).toEqual(installed);
  expect(f.db.prepare("SELECT count(*) AS n FROM data_tables").get()).toEqual({ n: 0 });
});
