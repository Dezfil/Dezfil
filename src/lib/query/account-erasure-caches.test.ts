import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { resetQueryInstance, connectQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { createMap } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import { inspectionCache } from "@/lib/geometry/inspection-cache";
import { inspectGeometry, inspectionEntriesForTests } from "@/lib/geometry/service";
import { namespaceFor } from "./namespace";
import { mapEvaluation } from "./context";
import { resolvePublication, publicationNamespacesForTests, publicationNamespacePendingForTests } from "./publication-namespace";
import { resolvePublishedView, publicationViewsForTests, publicationPendingForTests, publicationViewForTests } from "@/lib/publish/publication-resolution";
import type { PublishedView } from "@/lib/publish/publish-service";
import { collectInputs, inputCollectionsForTests, foldEvaluation, noteCatalogue, openCollections } from "./evaluation-inputs";
import { registerTableViews } from "./views";
import { trackInflight, readersForTests } from "./inflight";
import { eraseAccountQueryState } from "./account-erasure-query";
import { rememberOverLimit, overLimitLayersForTests } from "@/lib/render-over-limit";
import { erasureInventory } from "@/lib/auth/account-erasure-inventory";
import { proveErasure, type ErasureProbe } from "../../../test-support/account-erasure-proof";
const root = process.env.DEZFIL_DATA_DIR!; let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(root, "cache-erasure-")); process.env.DEZFIL_DATA_DIR = directory; closeMetadataDb(); resetQueryInstance(); });
afterEach(async () => { vi.restoreAllMocks(); closeMetadataDb(); resetQueryInstance(); process.env.DEZFIL_DATA_DIR = root; await rm(directory, { recursive: true, force: true }); });
const revision = (id: string) => readDocumentRevision({ kind: "map", id })!.editRevision;
it("purges populated publication, inspection and input-collection stores, including late work in another graph", async () => {
  const scopes = [testAccountScope(undefined, "target"), testAccountScope(undefined, "control")];
  const source = path.join(directory, "in.csv"); await writeFile(source, "label,lon,lat\nprivate sentinel,1,2\n");
  const tables = await Promise.all(scopes.map(s => ingestFile(s, source, "same.csv")));
  const maps = scopes.map(s => createMap(s, "Same"));
  const layerIds: string[] = [];
  for (let i = 0; i < 2; i++) {
    layerIds.push((await createLayer(scopes[i], maps[i].id, { name: "Same", sql: "SELECT * FROM same" }, { expectedRevision: revision(maps[i].id) })).id);
    rememberOverLimit({ layerId: layerIds[i], from: "(SELECT * FROM same) AS q", properties: ["label"], envelope: [], inputs: { datasets: [{ id: tables[i].id, file: tables[i].file }], catalogue: false }, limit: 1024 });
    metadataDb().prepare("UPDATE maps SET publish_token = ? WHERE id = ?").run(`token-${i}`, maps[i].id);
    await inspectGeometry(scopes[i], "same");
    await resolvePublishedView(`token-${i}`, 1, async () => ({ name: `retained-${i}` }) as unknown as PublishedView);
  }
  const conns = await Promise.all(scopes.map(() => connectQueryInstance()));
  for (let i = 0; i < 2; i++) await resolvePublication(conns[i], maps[i].id, namespaceFor(mapEvaluation(scopes[i], maps[i].id)));
  // Distinct keys force actual held resolution instead of a remembered hit.
  for (const map of maps) metadataDb().prepare("UPDATE layers SET sql = sql || ' ' WHERE map_id = ?").run(map.id);
  const rememberedBefore = publicationNamespacesForTests(), viewsBefore = [0, 1].map(i => publicationViewForTests(`token-${i}`));
  const hold = Promise.withResolvers<void>(), gates = conns.map(() => Promise.withResolvers<void>());
  for (let i = 0; i < 2; i++) {
    const original = conns[i].extractStatements.bind(conns[i]);
    vi.spyOn(conns[i], "extractStatements").mockImplementation(async (...args) => { gates[i].resolve(); await hold.promise; return original(...args); });
  }
  const namespaces = conns.map((c, i) => resolvePublication(c, maps[i].id, namespaceFor(mapEvaluation(scopes[i], maps[i].id))));
  await Promise.all(gates.map(g => g.promise));
  const views = scopes.map((_, i) => resolvePublishedView(`token-${i}`, Number.MAX_SAFE_INTEGER, async () => { await hold.promise; return { name: `late-${i}` } as unknown as PublishedView; }));
  const inspect = inspectionCache<string>();
  const inspections = tables.map((t, i) => inspect(t, async () => { await hold.promise; return `inspection-${i}`; }));
  const collectors: NonNullable<ReturnType<typeof openCollections>>[] = [];
  const collections = conns.map((c, i) => collectInputs(async () => {
    await registerTableViews(scopes[i], c); noteCatalogue(c); const mine = openCollections()!; collectors[i] = mine; foldEvaluation(mine, c); await hold.promise;
  }));
  // Registration itself uses no held SQL parsing, so evidence becomes populated.
  while (!collectors[0]?.[0].entries.size || !collectors[1]?.[0].entries.size) await new Promise(r => setImmediate(r));
  const readers = scopes.map(() => trackInflight(hold.promise));
  const outsideControl = () => ({ store: "table:data_tables", entries: (metadataDb().prepare("SELECT id FROM data_tables ORDER BY id").all() as { id: string }[]).map(r => r.id) });
  const observations: Record<string, () => [string[], string[]]> = {
    "query/publication-namespace.ts#remembered": () => maps.map(m => publicationNamespacesForTests().filter(k => k.includes(m.id))) as [string[], string[]],
    "query/publication-namespace.ts#pending": () => publicationNamespacePendingForTests() ? [["target pending"], ["control pending"]] : [[], []],
    "publish/publication-resolution.ts#cache": () => [publicationViewsForTests().filter(k => k === "token-0"), publicationViewsForTests().filter(k => k === "token-1")],
    "publish/publication-resolution.ts#pending": () => publicationPendingForTests() ? [["target assembly"], ["control assembly"]] : [[], []],
    "geometry/inspection-cache.ts#inspectionCache.entries": () => tables.map(t => inspect.entriesForTests().filter(k => k.includes(t.id))) as [string[], string[]],
    "geometry/inspection-cache.ts#inspectionCache.pending": () => inspect.pendingForTests() ? [["target inspection"], ["control inspection"]] : [[], []],
    "geometry/service.ts#cachedInspection": () => tables.map(t => inspectionEntriesForTests().filter(k => k.includes(t.id))) as [string[], string[]],
    "query/evaluation-inputs.ts#collecting": () => collectors.map(c => [...c[0].entries.keys()]) as [string[], string[]],
    "query/evaluation-inputs.ts#collections": () => inputCollectionsForTests() ? [["target collection"], ["control collection"]] : [[], []],
    "query/inflight.ts#inflight": () => readersForTests() ? [["target reader"], ["control reader"]] : [[], []],
    "render-over-limit.ts#remembered": () => layerIds.map(id => overLimitLayersForTests().filter(k => k === id)) as [string[], string[]],
  };
  const probes: Record<string, ErasureProbe> = Object.fromEntries(Object.entries(observations).map(([suffix, observe]) => [`memory:src/lib/${suffix}`, { populate() {}, dispose() {}, observe() { const [target, control] = observe(); return { target, control, outsideControl: outsideControl() }; } }]));
  const stores = Object.fromEntries(Object.keys(probes).map(id => [id, erasureInventory.stores[id as keyof typeof erasureInventory.stores]]));
  try {
    await proveErasure({ ...erasureInventory, stores }, probes, async () => {
      metadataDb().exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'"); vi.resetModules();
      const { eraseAccountQueryState: erase } = await import("./account-erasure-query");
      let done = false; const erased = erase("target", metadataDb()).then(() => { done = true; });
      await new Promise(r => setImmediate(r)); expect(done).toBe(false);
      hold.resolve(); await Promise.all([...namespaces, ...views, ...inspections, ...collections, ...readers]);
      expect(publicationNamespacesForTests()).toEqual(rememberedBefore);
      expect([0, 1].map(i => publicationViewForTests(`token-${i}`))).toEqual(viewsBefore);
      for (const conn of conns) conn.disconnectSync(); await erased;
    });
    expect(await inspect(tables[1], async () => "fresh provider inspection")).toBe("fresh provider inspection");
    expect(await resolvePublishedView("token-1", 1, async () => ({ name: "fresh view" }) as unknown as PublishedView)).toEqual({ name: "fresh view" });
  } finally { hold.resolve(); await Promise.allSettled([...namespaces, ...views, ...inspections, ...collections, ...readers]); for (const conn of conns) conn.disconnectSync(); if ((metadataDb().prepare("SELECT status FROM accounts WHERE id = 'target'").get() as { status: string })?.status === "deleting") await eraseAccountQueryState("target", metadataDb()); (await import("@/lib/metadata/db")).closeMetadataDb(); }
});
