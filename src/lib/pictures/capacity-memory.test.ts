import { afterAll, expect, it, vi } from "vitest";
const holds = vi.hoisted(() => new Map<string, ReturnType<typeof Promise.withResolvers<void>>>());
vi.mock("@/lib/export/render-image", () => ({ renderMapImage: async (_scope: unknown, input: { mapId: string }) => {
  const hold = Promise.withResolvers<void>(); holds.set(input.mapId, hold); await hold.promise; throw new Error("Released proof render");
} }));
import { isolatePictureData } from "@/lib/test-support/picture-data";
import { testAccountScope } from "@/lib/test-support/accounts";
import { createMap } from "@/lib/map-service";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { drainAccountWork } from "@/lib/auth/account-deletion-admission";
import { erasureInventory } from "@/lib/auth/account-erasure-inventory";
import { proveErasure } from "../../../test-support/account-erasure-proof";
import { PictureService } from "./service";
isolatePictureData();
afterAll(() => { vi.unstubAllEnvs(); closeMetadataDb(); });
it("removes a settled account attempt while an independently held control still occupies its slot", async () => {
  vi.stubEnv("DEZFIL_EXPORT_RENDER_CONCURRENCY", "3");
  const targetScope = testAccountScope(undefined, "target"), controlScope = testAccountScope(undefined, "control");
  const target = createMap(targetScope, "Target"), control = createMap(controlScope, "Control");
  let now = Date.now();
  const service = new PictureService({ baseUrl: "http://fixture.test", now: () => now, available: () => true });
  const id = "memory:picture-attempts";
  try {
    await service.request(target.id); await service.request(control.id); now += 5000; service.queue.tick();
    while (holds.size < 2) await new Promise(resolve => setImmediate(resolve));
    const probe = { populate() {}, dispose() {}, observe() {
      const ids = service.queue.runningIdsForTests();
      return { target: ids.filter(id => id === target.id), control: ids.filter(id => id === control.id) };
    } };
    expect(await proveErasure({ ...erasureInventory, stores: { [id]: erasureInventory.stores[id] } }, { [id]: probe }, async () => {
      metadataDb().prepare("UPDATE accounts SET status = 'deleting' WHERE id = ?").run(targetScope.accountId);
      holds.get(target.id)!.resolve(); await drainAccountWork(targetScope.accountId);
      await new Promise(resolve => setImmediate(resolve));
    })).toEqual([id]);
  } finally { for (const hold of holds.values()) hold.resolve(); await service.queue.drain(); }
});
