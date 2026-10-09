import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { eraseAccountCopies, capturePreparedCopies } from "./account-erasure-copies";
import { layerDownloadTickets, queryDownloadTickets } from "./layer-download-tickets";
import { createProjectExportTicket, claimProjectExportTicket, projectExportTickets } from "./project-export-tickets";
import { lookRetention } from "./look-retention";
import type { LookResult } from "./map-look";
import { erasureInventory } from "@/lib/auth/account-erasure-inventory";
import { proveErasure, type ErasureProbe } from "../../../test-support/account-erasure-proof";
const root = process.env.DEZFIL_DATA_DIR!;
let directory: string;
const binding = { layerId: "same-name", format: "csv" as const };
beforeEach(async () => {
  directory = await mkdtemp(path.join(root, "copies-")); process.env.DEZFIL_DATA_DIR = directory; closeMetadataDb();
  testAccountScope(undefined, "target"); testAccountScope(undefined, "control"); vi.useFakeTimers();
});
afterEach(async () => {
  await layerDownloadTickets.dispose(); await queryDownloadTickets.dispose(); await projectExportTickets.dispose();
  lookRetention.resetForTests(); vi.useRealTimers(); vi.restoreAllMocks(); closeMetadataDb(); process.env.DEZFIL_DATA_DIR = root;
  await rm(directory, { recursive: true, force: true });
});
async function file(name: string) {
  const destination = path.join(directory, "exports", name); await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, name);
  return { path: destination, filename: name, contentType: "text/plain", size: name.length, cleanup: () => rm(destination, { force: true }) };
}
function render(id: string): LookResult {
  return { id, mapId: "same-name", mapName: "Same", appearance: "light", state: {} as LookResult["state"],
    image: { width: 1, height: 1, bytes: 4, png: new Uint8Array([1,2,3,4]) }, thumbnail: { width: 1, height: 1, bytes: 4, png: new Uint8Array([1,2,3,4]) },
    source: { width: 1, height: 1 }, attribution: "", composition: { failures: [], abandoned: [] }, elapsedMs: 1 };
}
const deleting = () => metadataDb().exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'");
it("erases populated identity-bound copy stores while retaining another initiator's copies", async () => {
  const target = testAccountScope(undefined, "target"), control = testAccountScope(undefined, "control");
  const probes: Record<string, ErasureProbe> = {};
  const stores = Object.fromEntries(Object.entries(erasureInventory.stores).filter(([id]) => /look-retention|layer-download-tickets|project-export-tickets|queryDownloadTickets/.test(id)));
  for (const id of Object.keys(stores)) {
    const store = id.includes("look-retention") ? lookRetention : id.includes("project-export") ? projectExportTickets : id.includes("queryDownloadTickets") ? queryDownloadTickets : layerDownloadTickets;
    probes[id] = { populate() {}, observe() { const ids = store.idsForTests(); return { target: ids.filter(k => k.startsWith("target")), control: ids.filter(k => k.startsWith("control")) }; }, dispose() {} };
  }
  // Stable observed ids are independent of the eraser's selection.
  lookRetention.retain(target, render("target-render")); lookRetention.retain(control, render("control-render"));
  const originals = new Map<object, string[]>();
  for (const store of [layerDownloadTickets, queryDownloadTickets, projectExportTickets]) {
    const own = store === projectExportTickets ? createProjectExportTicket(target, "same-name", await file(`target-${originals.size}`)).ticket : store.prepare(target, binding, await file(`target-${originals.size}`));
    const other = store === projectExportTickets ? createProjectExportTicket(control, "same-name", await file(`control-${originals.size}`)).ticket : store.prepare(control, binding, await file(`control-${originals.size}`));
    originals.set(store, [own, other]);
    for (const [id, probe] of Object.entries(probes)) if ((id.includes("project-export") ? projectExportTickets : id.includes("queryDownloadTickets") ? queryDownloadTickets : id.includes("look-retention") ? lookRetention : layerDownloadTickets) === store) {
      probe.observe = () => ({ target: store.idsForTests().filter(k => k === own), control: store.idsForTests().filter(k => k === other) });
    }
  }
  // Control claims remain in flight beyond the target's expiry.
  for (const [store, ids] of originals) if (store !== projectExportTickets) (store as typeof layerDownloadTickets).claim(control, ids[1], binding);
  const result = proveErasure({ ...erasureInventory, stores }, probes, async () => {
    deleting(); const erased = eraseAccountCopies("target", metadataDb());
    await vi.advanceTimersByTimeAsync(60_000); await erased;
  });
  await result;
  expect(lookRetention.sizeForTests()).toEqual({ count: 1, bytes: 8 });
});
it("waits existing prepared copies through expiry, actual stream settlement and observed cleanup", async () => {
  const target = testAccountScope(undefined, "target"), control = testAccountScope(undefined, "control");
  const cleanup = Promise.withResolvers<void>();
  const staged = await file("target.csv");
  layerDownloadTickets.prepare(target, binding, { ...staged, cleanup: async () => { await cleanup.promise; await staged.cleanup(); } });
  const ticket = createProjectExportTicket(control, "same-name", await file("control.zip"));
  const claimed = claimProjectExportTicket(control, "same-name", ticket.ticket, ticket.key)!;
  let done = false; const drained = capturePreparedCopies().then(() => { done = true; });
  deleting(); let erasedDone = false; const erased = eraseAccountCopies("target", metadataDb()).then(() => { erasedDone = true; });
  try {
  await vi.advanceTimersByTimeAsync(59_999); expect(erasedDone).toBe(false); expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(1); expect(erasedDone).toBe(false); expect(done).toBe(false);
  claimed.settle(); await vi.advanceTimersByTimeAsync(0); expect(done).toBe(false);
  cleanup.resolve(); await Promise.all([drained, erased]); expect(done).toBe(true);
  expect(await readdir(path.join(directory, "exports"))).toEqual([]);
  } finally { cleanup.resolve(); claimed.settle(); await vi.advanceTimersByTimeAsync(60_000); await Promise.allSettled([drained, erased]); }
});
it("retains a failed unlink as an outstanding obligation and retries it", async () => {
  const staged = await file("target.csv"); let fail = true;
  layerDownloadTickets.prepare(testAccountScope(undefined, "target"), binding, { ...staged, cleanup: async () => { if (fail) throw new Error("unlink held"); await staged.cleanup(); } });
  deleting(); const erased = eraseAccountCopies("target", metadataDb()); const refused = expect(erased).rejects.toThrow("unlink held");
  await vi.advanceTimersByTimeAsync(60_000); await refused;
  expect(await readdir(path.join(directory, "exports"))).toEqual(["target.csv"]);
  fail = false; await eraseAccountCopies("target", metadataDb()); expect(await readdir(path.join(directory, "exports"))).toEqual([]);
});
it("purges singleton copies across two module graphs", async () => {
  lookRetention.retain(testAccountScope(undefined, "target"), render("target-render")); deleting();
  vi.resetModules(); const second = await import("./account-erasure-copies"); await second.eraseAccountCopies("target", metadataDb());
  expect(lookRetention.idsForTests()).toEqual([]);
});

it("drains held render buffers and browser closure across module graphs, preserving another initiator", async () => {
  const { renderMapImage } = await import("./render-image");
  const { testAccountScope: currentScope } = await import("@/lib/test-support/accounts");
  const { renderWorkForTests } = await import("./render-work");
  const { initialDefinition } = await import("./image-definition");
  const definition = initialDefinition({ appearance: "light", camera: { lng: 0, lat: 0, zoom: 1 }, canvasWidth: 1200, legendPresent: false, legendCorner: null, visibleWidgetIds: [], basemapLayers: null }, { width: 1920, scale: 1 });
  const buffers = Promise.withResolvers<{ png: Uint8Array }>(), closing = Promise.withResolvers<void>();
  const controlClose = Promise.withResolvers<void>();
  const pending = renderMapImage(currentScope(undefined, "target"), { mapId: "same-name", definition, baseUrl: "http://fixture.test", credential: "sentinel", driver: { launch: async () => ({ render: () => buffers.promise, close: () => closing.promise, kill() {} }) } });
  const outcome = pending.catch(error => error);
  // The control's image is made and its browser left closing: a render
  // settles only once its browser is gone, so its work stays held.
  let controlClosing = false;
  const control = renderMapImage(currentScope(undefined, "control"), { mapId: "same-name", definition, baseUrl: "http://fixture.test", credential: "control", driver: { launch: async () => ({ render: async () => ({ png: new Uint8Array([9]) }), close: () => { controlClosing = true; return controlClose.promise; }, kill() {} }) } }).catch(error => error);
  for (let i = 0; i < 50 && !controlClosing; i += 1) await vi.advanceTimersByTimeAsync(0);
  expect(controlClosing).toBe(true);
  const stores = Object.fromEntries(Object.entries(erasureInventory.stores).filter(([id, rule]) => /render-image|render-work/.test(id) && rule.action !== "retain"));
  const probes = Object.fromEntries(Object.keys(stores).map(id => [id, { populate() {}, observe: () => ({ target: renderWorkForTests("target") ? ["held target"] : [], control: renderWorkForTests("control") ? ["held control"] : [] }), dispose() {} }]));
  try {
    await proveErasure({ ...erasureInventory, stores }, probes, async () => {
      deleting(); vi.resetModules(); const second = await import("./account-erasure-copies");
      let done = false; const erased = second.eraseAccountCopies("target", metadataDb()).then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(0); expect(done).toBe(false);
      // The render's buffers drain; its browser is still closing.
      buffers.resolve({ png: new Uint8Array([1,2,3]) });
      await vi.advanceTimersByTimeAsync(0); expect(done).toBe(false);
      closing.resolve(); await outcome; await erased; expect(done).toBe(true);
    });
  } finally { buffers.resolve({ png: new Uint8Array() }); closing.resolve(); controlClose.resolve(); await outcome; await control; (await import("@/lib/metadata/db")).closeMetadataDb(); }
});

it("keeps ordinary copy reads and claims usable with scopes minted in another compiled graph", async () => {
  const scope = testAccountScope(undefined, "control"); lookRetention.retain(scope, render("cross-graph"));
  const layer = layerDownloadTickets.prepare(scope, binding, await file("cross-layer"));
  const query = queryDownloadTickets.prepare(scope, binding, await file("cross-query"));
  const project = createProjectExportTicket(scope, "project", await file("cross-project"));
  vi.resetModules();
  const fresh = (await import("@/lib/test-support/accounts")).testAccountScope(undefined, "control");
  const copies = await import("./layer-download-tickets"), projectCopies = await import("./project-export-tickets");
  expect((await import("./look-retention")).lookRetention.read(fresh, "cross-graph", "full")).toEqual(new Uint8Array([1,2,3,4]));
  for (const [store, ticket] of [[copies.layerDownloadTickets, layer], [copies.queryDownloadTickets, query]] as const) {
    const claim = store.claim(fresh, ticket, binding)!; expect(claim.registerAbort(() => {})).toBe(true); claim.complete();
    expect(store.status(fresh, ticket, binding)).toBe("complete");
  }
  const claimed = projectCopies.claimProjectExportTicket(fresh, "project", project.ticket, project.key); expect(claimed).not.toBeNull(); claimed!.settle();
  await Promise.all([copies.layerDownloadTickets.settlePrepared(), copies.queryDownloadTickets.settlePrepared(), projectCopies.projectExportTickets.settlePrepared()]);
  (await import("@/lib/metadata/db")).closeMetadataDb();
});
