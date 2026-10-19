import { pictureBindings, rememberBindings, bindingsChanged } from "./bindings";
import { accessSync, constants } from "node:fs";
import { metadataDb } from "@/lib/metadata/db";
import { mapOwnerWorkScope } from "@/lib/auth/scope";
import { publishedPictureInputs, servedThumbnails } from "@/lib/map-thumbnails";
import { limits } from "@/lib/limits";
import { chromiumPath } from "@/lib/export/render-drive";
import { renderMapImage } from "@/lib/export/render-image";
import { admitResourceWork, inDetachedDeletionWork } from "@/lib/auth/account-deletion-work";
import { PictureQueue } from "./queue";
import { getPictureState, requestPicture, type PictureState } from "./state";
import { initializePicture, adoptPicture } from "./migration";
import { reconcilePictureFiles } from "./reconcile";
import { pictureTarget, publishPicture } from "./publication";
import { mintPictureCredential, revokePictureCredential, renewPictureCredential } from "./credential";
import { inputsAreCurrent, readAttemptInputs } from "./inputs";
import { cardDefinition, completePicture } from "./card";
export function pictureRendererAvailable(): boolean {
  try { accessSync(chromiumPath(), constants.X_OK); return true; } catch { return false; }
}
export interface PictureServiceOptions {
  baseUrl: string;
  now?: () => number;
  available?: () => boolean;
  run?: (state: PictureState) => Promise<void>;
}
export class PictureService {
  readonly queue: PictureQueue;
  private readonly now: () => number;
  private rendererReady = false;
  constructor(private readonly options: PictureServiceOptions) {
    this.now = options.now ?? Date.now;
    this.queue = new PictureQueue({ db: metadataDb(), now: this.now, available: () => this.rendererReady,
      capacity: () => Math.max(1, limits.exportRenderConcurrency - 1),
      building: mapId => !!metadataDb().prepare("SELECT 1 FROM layer_tiles t JOIN layers l ON l.id = t.layer_id WHERE l.map_id = ? AND l.visible = 1 AND t.state = 'building'").get(mapId),
      run: options.run ?? (state => this.render(state)),
    });
  }
  async look(): Promise<void> {
    this.rendererReady = (this.options.available ?? pictureRendererAvailable)();
    const maps = metadataDb().prepare("SELECT m.id, m.updated_at FROM maps m JOIN accounts a ON a.id = m.owner_id WHERE a.status = 'active' ORDER BY m.updated_at DESC, m.id").all() as { id: string; updated_at: string }[];
    for (const map of maps) {
      try {
        const scope = mapOwnerWorkScope(map.id);
        const { target, inputs: bindings } = await pictureBindings(scope, map.id);
        const hasPicture = (await servedThumbnails(scope, [map.id])).has(map.id);
        initializePicture(map.id, target.digest, hasPicture, Date.parse(map.updated_at), metadataDb());
        let state = requestPicture(map.id, target.digest, this.now(), bindingsChanged(map.id, bindings));
        rememberBindings(map.id, bindings);
        const inputs = await publishedPictureInputs(map.id);
        if (state.state === "current" && inputs && !inputsAreCurrent(inputs)) state = requestPicture(map.id, target.digest, this.now(), true);
        await reconcilePictureFiles(map.id, hasPicture, this.now());
      } catch {
        // Deletion or changed ownership during a file read removes this
        // candidate from the look; the next committed change supplies it.
      }
    }
    this.queue.tick();
  }
  async request(mapId: string, force = false): Promise<PictureState> {
    const scope = mapOwnerWorkScope(mapId);
    const { target, inputs } = await pictureBindings(scope, mapId);
    this.rendererReady = (this.options.available ?? pictureRendererAvailable)();
    const state = requestPicture(mapId, target.digest, this.now(), force || bindingsChanged(mapId, inputs));
    rememberBindings(mapId, inputs);
    this.queue.tick();
    return getPictureState(mapId) ?? state;
  }
  async adopt(mapId: string): Promise<void> {
    const scope = mapOwnerWorkScope(mapId);
    const { target, inputs } = await pictureBindings(scope, mapId);
    if ((await servedThumbnails(scope, [mapId])).has(mapId)) { adoptPicture(mapId, target.digest, this.now()); rememberBindings(mapId, inputs); }
    else await this.request(mapId);
  }
  async dataChanged(datasetId: string): Promise<void> {
    const maps = metadataDb().prepare("SELECT id FROM maps").all() as { id: string }[];
    for (const map of maps) {
      try {
        const { target, inputs, resolved } = await pictureBindings(mapOwnerWorkScope(map.id), map.id);
        if (!resolved || !inputs.datasets.some(input => input.id === datasetId)) continue;
        requestPicture(map.id, target.digest, this.now(), bindingsChanged(map.id, inputs));
        rememberBindings(map.id, inputs);
      } catch { /* A removed map or inactive owner contributes no work. */ }
    }
    this.queue.tick();
  }
  private async render(state: PictureState): Promise<void> {
    const scope = mapOwnerWorkScope(state.mapId);
    const { target } = await pictureBindings(scope, state.mapId);
    if (target.digest !== state.digest) { await this.request(state.mapId); return; }
    const lease = admitResourceWork(scope, [{ table: "maps", id: state.mapId }]);
    // A whole pair plus bounded shutdown; individual drive budgets start
    // after admission. The service admits only its background capacity.
    let credential: string | undefined;
    try {
      credential = mintPictureCredential(state.mapId, Date.now() + 2 * limits.assistantLookTimeoutMs + 10000);
      const workCredential = credential;
      await inDetachedDeletionWork(lease, async () => {
        const images: { light: Uint8Array; dark?: Uint8Array } = { light: new Uint8Array() };
        for (const appearance of target.basemaps.dark ? ["light", "dark"] as const : ["light"] as const) {
          const result = await renderMapImage(scope, { mapId: state.mapId, definition: cardDefinition(target.map.viewport, appearance),
            baseUrl: this.options.baseUrl, credential: workCredential, background: true, budgetMs: limits.assistantLookTimeoutMs,
            admitted: () => renewPictureCredential(workCredential, Date.now() + limits.assistantLookTimeoutMs + 10000),
            standing: () => { lease.assertCommit(); const fresh = pictureTarget(scope, state.mapId, target.sketchIds); if (fresh.digest !== target.digest || getPictureState(state.mapId)?.requestedGeneration !== state.requestedGeneration) throw new Error("The picture request changed."); },
          });
          images[appearance] = completePicture(result, state.mapId, target.map.layers.filter(l => l.visible).map(l => l.id), target.basemaps[appearance]!.url);
        }
        lease.assertCommit();
        await publishPicture(scope, target, state.requestedGeneration, images, readAttemptInputs(workCredential, target.map.layers.filter(l => l.visible).map(l => l.id)));
      });
    } finally { if (credential) revokePictureCredential(credential); lease.release(); }
  }
}
