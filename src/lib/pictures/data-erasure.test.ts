import { afterAll, expect, it, vi } from "vitest";
import { isolatePictureData } from "@/lib/test-support/picture-data";
import { testAccountScope } from "@/lib/test-support/accounts";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { createMap } from "@/lib/map-service";
import { erasureInventory } from "@/lib/auth/account-erasure-inventory";
import { proveErasure } from "../../../test-support/account-erasure-proof";
import { PictureService } from "./service";
import * as bindings from "./bindings";
isolatePictureData();
afterAll(closeMetadataDb);
it("drains dependency resolution before purging coalesced identities, with an outside control", async () => {
  const target = testAccountScope(undefined, "target"), control = testAccountScope(undefined, "control");
  const map = createMap(target, "Resolving");
  let now = Date.now();
  const service = new PictureService({ now: () => now, available: () => false, baseUrl: "http://fixture.test" });
  const begun = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const original = bindings.pictureBindings;
  const held = vi.spyOn(bindings, "pictureBindings").mockImplementation(async (...args) => {
    begun.resolve(); await release.promise; return original(...args);
  });
  const id = "memory:picture-data";
  try {
    service.dataChanged("resolving-input"); now += 5000;
    const ticking = service.tick(); await begun.promise;
    let drained = false; const draining = service.drain().then(() => { drained = true; });
    await new Promise(resolve => setImmediate(resolve)); expect(drained).toBe(false);
    service.dataChanged("target-input"); service.dataChanged("control-input");
    const probe = { populate() {}, dispose() {}, observe() {
      const ids = service.pendingDataIdsForTests();
      return { target: ids.filter(id => id === "target-input"), control: ids.filter(id => id === "control-input"),
        outsideControl: { store: "table:accounts", entries: (metadataDb().prepare("SELECT id FROM accounts WHERE id IN (?, ?) ORDER BY id").all(target.accountId, control.accountId) as { id: string }[]).map(row => row.id) } };
    } };
    const inventory = { ...erasureInventory, stores: { [id]: erasureInventory.stores[id] } };
    await expect(proveErasure(inventory, { [id]: probe }, async () => {})).rejects.toThrow("Target retained");
    expect(await proveErasure(inventory, { [id]: probe }, async () => {
      release.resolve(); await ticking; await draining;
      expect(drained).toBe(true); expect(service.busy).toBe(false);
      service.clearPendingData();
    })).toEqual([id]);
    expect(service.pendingDataIdsForTests()).toEqual([]);
    expect(metadataDb().prepare("SELECT id FROM maps WHERE id = ?").get(map.id)).toBeDefined();
  } finally { release.resolve(); await service.drain(); held.mockRestore(); }
});
