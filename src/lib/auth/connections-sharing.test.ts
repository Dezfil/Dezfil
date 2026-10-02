import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { resetSecretKeyCache } from "@/lib/secrets";
import { ingestFile } from "@/lib/ingest/ingest";
import { insertConnection } from "@/lib/metadata/connections";
import { createMap } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import { buildTools } from "@/lib/tools/tools";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { shareProject } from "@/lib/test-support/sharing";
import type { AccountScope } from "./scope";

/**
 * Connections stay their owner's under sharing. Ada owns a PostGIS
 * connection and a snapshot imported through it, `parcels`, filed in her
 * project P with Bob as an editor and Vic as a viewer; Cyd reaches nothing.
 * Every operation that bears a connection is driven as a member against Ada's
 * connection and compared with a connection that never existed; the shared
 * snapshot's reads, the catalogue, the dependency read and a project archive
 * are searched for every fact about the connection; refresh stays Ada's; and
 * no operation transfers a connection.
 */
const CONNECTION = { id: "conn-ada", name: "Ada's warehouse", host: "db.internal.example", port: 5432, database: "gis",
  username: "reader", password: "fixture-only", ssl: false };
/** Everything the connection would disclose about Ada's source. */
const FACTS = ["conn-ada", "Ada's warehouse", "db.internal.example", "secret_schema", "secret_table", "fixture-only"];

const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
let scopes: Record<string, AccountScope>;
let parcels: string;
let mapId: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "connections-sharing-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb(); resetQueryInstance(); resetSecretKeyCache();
  scopes = Object.fromEntries(["ada", "bob", "vic", "cyd"].map((id) => [id, testAccountScope(undefined, id)]));
  insertConnection(scopes.ada, CONNECTION);
  const file = path.join(directory, "parcels.csv");
  await writeFile(file, "sentinel,lon,lat\nada parcels,1,2\n");
  parcels = (await ingestFile(scopes.ada, file, "parcels.csv")).id;
  metadataDb().prepare("UPDATE data_tables SET source = 'postgis', source_filename = 'secret_schema.secret_table', source_params = ? WHERE id = ?")
    .run(JSON.stringify({ connectionId: CONNECTION.id, connectionName: CONNECTION.name, schema: "secret_schema", table: "secret_table" }), parcels);
  shareProject("ada", "P", [["bob", "editor"], ["vic", "viewer"]], [parcels]);
  const map = createMap(scopes.ada, "Survey", "P");
  await createLayer(scopes.ada, map.id, { name: "Parcels", sql: "SELECT * FROM parcels" }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
  mapId = map.id;
});
afterEach(async () => { closeMetadataDb(); resetQueryInstance(); resetSecretKeyCache(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function call(account: string, load: () => Promise<Record<string, unknown>>, method: string, url: string,
  params: Record<string, string> = {}, body?: unknown) {
  const request = testAccountRequest(new Request(`http://instance.test${url}`, {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), undefined, account);
  const response = await ((await load())[method] as Handler)(request, { params: Promise.resolve(params) });
  const text = await response.text();
  return { status: response.status, text };
}
const routes: Record<string, () => Promise<Record<string, unknown>>> = {
  "/api/connections/postgis": () => import("@/app/api/connections/postgis/route"),
  "/api/connections/postgis/{id}": () => import("@/app/api/connections/postgis/[id]/route"),
  "/api/connections/postgis/{id}/test": () => import("@/app/api/connections/postgis/[id]/test/route"),
  "/api/connections/postgis/{id}/tables": () => import("@/app/api/connections/postgis/[id]/tables/route"),
  "/api/connections/postgis/{id}/preview": () => import("@/app/api/connections/postgis/[id]/preview/route"),
  "/api/connections/postgis/{id}/snapshots": () => import("@/app/api/connections/postgis/[id]/snapshots/route"),
  "/api/imports/postgis": () => import("@/app/api/imports/postgis/route"),
};
const stored = () => [
  metadataDb().prepare("SELECT * FROM pg_connections ORDER BY id").all(),
  metadataDb().prepare("SELECT id, name, owner_id, file FROM data_tables ORDER BY id").all(),
];
const noFacts = (text: string) => { for (const fact of FACTS) expect(text, fact).not.toContain(fact); };

describe("connection-bearing operations under a project grant", () => {
  it("are exactly the ones classified here", () => {
    const document = buildOpenApiDocument() as unknown as { paths: Record<string, unknown> };
    const bearing = Object.keys(document.paths)
      .filter((p) => p.includes("connection") || JSON.stringify(document.paths[p]).includes("connectionId")).sort();
    expect(bearing).toEqual(Object.keys(routes).sort());
  });

  it("answer every member and outsider about Ada's connection exactly as about one that never existed, changing nothing", async () => {
    const document = buildOpenApiDocument() as unknown as { paths: Record<string, Record<string, unknown>> };
    const before = stored();
    let driven = 0;
    for (const [route, load] of Object.entries(routes)) {
      for (const method of Object.keys(document.paths[route]).map((m) => m.toUpperCase())) {
        // Creating and listing name no connection; listing is searched below.
        if (route === "/api/connections/postgis") continue;
        for (const account of ["bob", "vic", "cyd"]) {
          // A well-formed request for each, so only the connection decides.
          const body = (id: string) => method === "GET" || method === "DELETE" ? undefined
            : route === "/api/imports/postgis" ? { connectionId: id, schema: "secret_schema", table: "secret_table", name: "copied" }
            : route.endsWith("/preview") ? { schema: "secret_schema", table: "secret_table" }
            : method === "PATCH" ? { name: "Renamed" } : {};
          const as = (id: string) => call(account, load, method, route.replace("{id}", id), { id }, body(id));
          const hidden = await as(CONNECTION.id);
          const never = await as("never-existed");
          expect(hidden.status, `${method} ${route} as ${account}`).toBe(404);
          expect(hidden, `${method} ${route} as ${account}`).toEqual(never);
          noFacts(hidden.text);
          driven++;
        }
      }
    }
    expect(driven).toBe(21);
    expect(stored()).toEqual(before);
    for (const account of ["bob", "vic"]) {
      const listed = await call(account, routes["/api/connections/postgis"], "GET", "/api/connections/postgis");
      expect(listed.status).toBe(200);
      noFacts(listed.text);
    }
  });

  it("leaves refreshing the shared snapshot to its owner", async () => {
    const before = stored();
    const refresh = () => import("@/app/api/tables/[name]/refresh/route");
    for (const account of ["bob", "vic"]) {
      const refused = await call(account, refresh, "POST", "/api/tables/ada.parcels/refresh", { name: "ada.parcels" }, {});
      expect(refused.status).toBe(403);
      expect(JSON.parse(refused.text).error.code).toBe("forbidden");
    }
    const hidden = await call("cyd", refresh, "POST", "/api/tables/ada.parcels/refresh", { name: "ada.parcels" }, {});
    const never = await call("cyd", refresh, "POST", "/api/tables/ada.nothing/refresh", { name: "ada.nothing" }, {});
    expect(hidden.status).toBe(404);
    expect(hidden).toEqual(never);
    expect(stored()).toEqual(before);
  });

  it("shows a member the snapshot's origin kind and nothing about the connection, on every read", async () => {
    const tables = () => import("@/app/api/tables/route");
    const table = () => import("@/app/api/tables/[name]/route");
    const catalogue = () => import("@/app/api/catalogue/tables/route");
    const dependencies = () => import("@/app/api/maps/[id]/dependencies/route");
    for (const account of ["bob", "vic"]) {
      const listing = await call(account, tables, "GET", "/api/tables");
      const entry = (JSON.parse(listing.text) as { id: string; source: string; sourceParams: unknown; sourceFilename: unknown }[]).find((t) => t.id === parcels)!;
      expect(entry).toMatchObject({ source: "postgis", sourceParams: null, sourceFilename: null });
      noFacts(listing.text);
      const read = await call(account, table, "GET", "/api/tables/ada.parcels", { name: "ada.parcels" });
      expect(JSON.parse(read.text)).toMatchObject({ source: "postgis", sourceParams: null, sourceFilename: null });
      noFacts(read.text);
      noFacts((await call(account, catalogue, "GET", "/api/catalogue/tables")).text);
      noFacts((await call(account, dependencies, "GET", `/api/maps/${mapId}/dependencies`, { id: mapId })).text);
    }
    // Ada sees her own snapshot as stored.
    const own = await call("ada", table, "GET", "/api/tables/parcels", { name: "parcels" });
    expect(JSON.parse(own.text)).toMatchObject({ sourceFilename: "secret_schema.secret_table", sourceParams: { connectionId: CONNECTION.id } });
  });

  it("carries no connection fact into a project archive, whoever exports it", async () => {
    const exporting = () => import("@/app/api/projects/[id]/export/route");
    for (const account of ["vic", "bob", "ada"]) {
      const request = testAccountRequest(new Request("http://instance.test/api/projects/P/export", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: "p", maps: [mapId], datasets: [parcels] }),
      }), undefined, account);
      const response = await ((await exporting()).POST as unknown as Handler)(request, { params: Promise.resolve({ id: "P" }) });
      expect(response.status, account).toBe(200);
      const zip = await JSZip.loadAsync(Buffer.from(await response.arrayBuffer()));
      for (const name of Object.keys(zip.files).filter((entry) => entry.endsWith(".json"))) {
        noFacts(await zip.file(name)!.async("string"));
      }
    }
  });

  it("transfers no connection: only projects, maps and workflows have a transfer", () => {
    const document = buildOpenApiDocument() as unknown as { paths: Record<string, unknown> };
    expect(Object.keys(document.paths).filter((p) => p.includes("transfer")).sort())
      .toEqual(["/api/maps/{id}/transfer", "/api/projects/{id}/transfer", "/api/recipes/{id}/transfer"]);
    expect(buildTools().map((tool) => tool.name).filter((name) => name.includes("transfer")).sort())
      .toEqual(["transfer_map", "transfer_project", "transfer_workflow"]);
  });
});
