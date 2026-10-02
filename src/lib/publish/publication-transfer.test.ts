import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { documentFacts } from "@/lib/metadata/document-facts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { getAccount } from "@/lib/metadata/accounts";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { createMap } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import { boundedEvaluation } from "@/lib/query/bounded";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { shareProject } from "@/lib/test-support/sharing";
import type { AccountScope } from "@/lib/auth/scope";
import type { DataTable } from "@/lib/metadata/tables";
import { resolvePublication } from "./publication-scope";
import { getPublishedView, publishMap, resetPublishCache } from "./publish-service";
import { resetRateLimits } from "./rate-limit";

/**
 * A transferred map keeps its publication, which becomes the new owner's and
 * renders in the map's home with the new owner's reach.
 *
 * Pat owns project P; Ada and Ed are its editors. Ada's `roads` is filed in P
 * and her `parks` is not; Ed holds a `parks` of his own. Ada's map in P draws
 * both of hers by plain name and is published. She transfers it to Ed: the
 * token stays, the link keeps drawing her `roads` (Ed reaches it through P)
 * and fails her `parks` (he does not), never drawing his own same-named
 * dataset, and only Ed can now change or revoke the publication.
 */
const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
let scopes: Record<string, AccountScope>;
let tables: Record<string, DataTable>;
let mapId: string;
let token: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "publication-transfer-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb(); resetQueryInstance(); resetPublishCache(); resetRateLimits();
  scopes = Object.fromEntries(["pat", "ada", "ed"].map((id) => [id, testAccountScope(undefined, id)]));
  tables = {};
  for (const [owner, name] of [["ada", "roads"], ["ada", "parks"], ["ed", "parks"]]) {
    const file = path.join(directory, `${owner}-${name}.csv`);
    await writeFile(file, `sentinel,lon,lat\n${owner} ${name},1,2\n`);
    tables[`${owner}.${name}`] = await ingestFile(scopes[owner], file, `${name}.csv`);
  }
  shareProject("pat", "P", [["ada", "editor"], ["ed", "editor"]], [tables["ada.roads"].id]);
  const map = createMap(scopes.ada, "Survey", "P");
  mapId = map.id;
  await createLayer(scopes.ada, map.id, { name: "Roads", sql: "SELECT * FROM roads" }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
  await createLayer(scopes.ada, map.id, { name: "Parks", sql: "SELECT * FROM parks" }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
  token = publishMap(scopes.ada, map.id).token;
});
afterEach(async () => {
  closeMetadataDb(); resetQueryInstance(); resetPublishCache(); vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

type Rendered = { ok: boolean; error?: { code: string }; geojson?: { features: { properties: Record<string, unknown> }[] } };
const layerOf = (view: Awaited<ReturnType<typeof getPublishedView>>, name: string) =>
  view!.layers.find((layer) => layer.name === name)!.render as Rendered;
const sentinels = (rendered: Rendered) => rendered.geojson!.features.map((feature) => feature.properties.sentinel);
type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
async function call(account: string, route: "transfer" | "publish", method: string, body?: unknown) {
  const load = route === "transfer" ? () => import("@/app/api/maps/[id]/transfer/route") : () => import("@/app/api/maps/[id]/publish/route");
  const request = testAccountRequest(new Request(`http://instance.test/api/maps/${mapId}/${route}`, { method,
    headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), undefined, account);
  const response = await ((await load()) as unknown as Record<string, Handler>)[method](request, { params: Promise.resolve({ id: mapId }) });
  return { status: response.status, body: response.status === 204 ? null : await response.json() as unknown };
}
const mounted = (publication: NonNullable<ReturnType<typeof resolvePublication>>["scope"]) => boundedEvaluation(async (conn) =>
  (await conn.runAndReadAll("SELECT view_name FROM duckdb_views() WHERE NOT internal ORDER BY view_name")).getRowObjects()
    .map((row) => String(row.view_name)), { scope: publication });

describe("a transferred map's publication", () => {
  it("keeps its token and renders in the map's home with the new owner's reach, rebinding nothing", async () => {
    const before = await getPublishedView(token, Date.now());
    expect(sentinels(layerOf(before, "Roads"))).toEqual(["ada roads"]);
    expect(sentinels(layerOf(before, "Parks"))).toEqual(["ada parks"]);
    expect(await mounted(resolvePublication(token)!.scope)).toEqual(["parks", "roads"]);

    const transferred = await call("ada", "transfer", "POST", { to: getAccount("ed")!.sqlName });
    expect(transferred).toEqual({ status: 200, body: { id: mapId, editRevision: documentFacts({ kind: "map", id: mapId }).editRevision, owner: { name: "ed", sqlName: getAccount("ed")!.sqlName } } });
    const map = metadataDb().prepare("SELECT owner_id, home_account_id, publish_token FROM maps WHERE id = ?").get(mapId);
    expect(map).toEqual({ owner_id: "ed", home_account_id: "ada", publish_token: token });

    const publication = resolvePublication(token)!;
    expect(publication.scope.ownerId).toBe("ed");
    expect(await mounted(publication.scope)).toEqual(["roads"]);
    const after = await getPublishedView(token, Date.now() + 1);
    expect(sentinels(layerOf(after, "Roads"))).toEqual(["ada roads"]);
    expect(layerOf(after, "Parks").ok).toBe(false);
    expect(JSON.stringify(after)).not.toContain("ed parks");
  }, 60_000);

  it("belongs to the new owner: only they read its settings, change or revoke it", async () => {
    expect((await call("ada", "transfer", "POST", { to: getAccount("ed")!.sqlName })).status).toBe(200);
    expect(await call("ed", "publish", "GET")).toMatchObject({ status: 200, body: { token } });
    expect(await call("ada", "publish", "DELETE")).toMatchObject({ status: 403, body: { error: { code: "forbidden" } } });
    expect(await call("ada", "publish", "POST", { theme: "light" })).toMatchObject({ status: 403 });
    expect(await getPublishedView(token, Date.now())).not.toBeNull();
    expect(await call("ed", "publish", "DELETE")).toEqual({ status: 200, body: documentFacts({ kind: "map", id: mapId }) });
    expect(await getPublishedView(token, Date.now() + 1)).toBeNull();
  }, 60_000);
});
