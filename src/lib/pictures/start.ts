import { registerRetainedStore } from "@/lib/auth/account-deletion-admission";
import { observePictureChanges, observePictureDataChanges } from "./hooks";
import { metadataDb } from "@/lib/metadata/db";
import { PictureService } from "./service";
const key = Symbol.for("dezfil.picture-service");
const host = process as typeof process & { [key]?: { service: PictureService; stop: () => void } };
/** Boot waits for the listener to answer before any render can ask it for a
 * page. Timers are unreferenced and there is only one service across bundles. */
export function startPictures(baseUrl = `http://127.0.0.1:${process.env.PORT ?? "3000"}`): void {
  if (host[key]) return;
  metadataDb().prepare("UPDATE map_pictures SET work_key = NULL, work_owner = NULL, work_expires_at = NULL, work_inputs = NULL").run();
  const service = new PictureService({ baseUrl });
  registerRetainedStore({ drain: () => service.queue.drain(), busy: () => service.queue.busy, clear: () => {} });
  const stopChanges = observePictureChanges(event => {
    void (event.inherited ? service.adopt(event.mapId) : service.request(event.mapId, event.force)).catch(() => {});
  });
  const stopData = observePictureDataChanges(id => { void service.dataChanged(id).catch(() => {}); });
  let serving = false, looking = false, lastLook = -Infinity;
  const timer = setInterval(() => {
    if (looking) return;
    if (serving && Date.now() - lastLook < 3600000) { service.queue.tick(); return; }
    looking = true;
    void (async () => {
      if (!serving) {
        try { const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1000) }); await response.body?.cancel(); serving = response.ok; }
        catch { return; }
        if (!serving) return;
      }
      await service.look(); lastLook = Date.now();
    })().catch(error => console.warn("Picture look failed", error)).finally(() => { looking = false; });
  }, 1000);
  timer.unref();
  host[key] = { service, stop: () => { clearInterval(timer); stopChanges(); stopData(); } };
}
export function activePictureService(): PictureService | undefined { return host[key]?.service; }
