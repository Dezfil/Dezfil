import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { resetQueryInstance } from "@/lib/duckdb";
import { createMap } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import { shareProject } from "@/lib/test-support/sharing";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import type { HistoryStep } from "@/lib/metadata/history";
import * as admission from "@/lib/save-admission";
import { admitLayerUpdate, layerAdmissionForTests, layerAdmissionsPendingForTests } from "@/lib/layer-admission";
import { admitHistoryTarget, historyAdmissionsForTests, historyPendingForTests } from "@/lib/history-admission-cache";
import { eraseAccountQueryState } from "./account-erasure-query";
import { erasureInventory } from "@/lib/auth/account-erasure-inventory";
import { proveErasure } from "../../../test-support/account-erasure-proof";
const root = process.env.DEZFIL_DATA_DIR!; let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(root, "admissions-erasure-")); process.env.DEZFIL_DATA_DIR = directory; closeMetadataDb(); resetQueryInstance(); });
afterEach(async () => { vi.restoreAllMocks(); closeMetadataDb(); resetQueryInstance(); process.env.DEZFIL_DATA_DIR = root; await rm(directory, { recursive: true, force: true }); });
it("purges actual saved layer and history admissions after all held validation has settled", async () => {
  const owner = testAccountScope(undefined, "owner"), scopes = [testAccountScope(undefined, "target"), testAccountScope(undefined, "control")];
  shareProject("owner", "p", [["target", "editor"], ["control", "editor"]]);
  const maps = scopes.map(() => createMap(owner, "Same"));
  const layers: Awaited<ReturnType<typeof createLayer>>[] = [];
  for (const map of maps) {
    const layer = await createLayer(owner, map.id, { name: "Layer", sql: "SELECT ST_Point(1,2) AS geom" }, { expectedRevision: readDocumentRevision({ kind: "map", id: map.id })!.editRevision });
    layers.push(layer); metadataDb().prepare("UPDATE maps SET project_id = 'p' WHERE id = ?").run(map.id);
  }
  const revisions = maps.map(m => readDocumentRevision({ kind: "map", id: m.id })!.editRevision!);
  const steps = (id: string) => [{ id, scope: "layer", before: { sql: "SELECT 1" }, after: { sql: "SELECT 2" } }] as unknown as HistoryStep[];
  const spy = vi.spyOn(admission, "admitMapSql").mockResolvedValue({ bound: [{ id: "private-sentinel", written: "same" }] });
  const saved = await Promise.all(scopes.map((s,i) => admitLayerUpdate(s, layers[i].id, { sql: "SELECT ST_Point(3,4) AS geom" }, undefined, revisions[i])));
  await Promise.all(scopes.map((s,i) => admitHistoryTarget(s, maps[i].id, revisions[i], steps("before"), "undo")));
  const hold = Promise.withResolvers<void>();
  spy.mockImplementation(async () => { await hold.promise; return { bound: [{ id: "late-private-sentinel", written: "same" }] }; });
  const pending = scopes.flatMap((s,i) => [admitLayerUpdate(s, layers[i].id, { sql: "SELECT ST_Point(5,6) AS geom" }, undefined, revisions[i]), admitHistoryTarget(s, maps[i].id, revisions[i], steps("held"), "redo")]);
  const settled = Promise.allSettled(pending);
  const ids = ["layer-admission.ts#updateAdmissions", "layer-admission.ts#pending", "history-admission-cache.ts#caches", "history-admission-cache.ts#pending"].map(s => `memory:src/lib/${s}`);
  const stores = Object.fromEntries(ids.map(id => [id, erasureInventory.stores[id as keyof typeof erasureInventory.stores]]));
  const probes = Object.fromEntries(ids.map(id => [id, { populate() {}, dispose() {}, observe() {
    const exists = (index: number) => id.endsWith("#updateAdmissions") ? layerAdmissionForTests(saved[index].layer) : id.endsWith("#caches") ? historyAdmissionsForTests(metadataDb()) > 0 : id.includes("history-") ? historyPendingForTests() > 0 : layerAdmissionsPendingForTests() > 0;
    return { target: exists(0) ? ["target"] : [], control: exists(1) ? ["control"] : [], outsideControl: { store: "table:maps", entries: (metadataDb().prepare("SELECT id FROM maps ORDER BY id").all() as { id: string }[]).map(r => r.id) } };
  } }]));
  try {
    await proveErasure({ ...erasureInventory, stores }, probes, async () => {
      metadataDb().exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'"); let done = false;
      const erased = eraseAccountQueryState("target", metadataDb()).then(() => { done = true; });
      await new Promise(r => setImmediate(r)); expect(done).toBe(false); hold.resolve(); const results = await settled; await erased;
      const control = results[2]; expect(control.status).toBe("fulfilled");
      if (control.status === "fulfilled" && control.value) expect(layerAdmissionForTests(control.value.layer)).toBe(false);
    });
    const before = spy.mock.calls.length;
    await admitHistoryTarget(scopes[1], maps[1].id, revisions[1], steps("before"), "undo"); expect(spy.mock.calls.length).toBe(before + 1);
  } finally { hold.resolve(); await settled; }
});
