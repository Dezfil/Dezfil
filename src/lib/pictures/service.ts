import { pictureBindings, schedulingBindings, bindingMayUse, rememberBindings, bindingsChanged } from "./bindings";
import { metadataDb } from "@/lib/metadata/db";
import { mapOwnerWorkScope } from "@/lib/auth/scope";
import { publishedPictureInputs, servedThumbnails } from "@/lib/map-thumbnails";
import { limits } from "@/lib/limits";
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
import { pictureRendererAvailable, pictureRendererFailed, retryPictureRenderer } from "./renderer";
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
  private rendererFailed = false;
  private dataIds = new Set<string>();
  private dataStartedAt = 0;
  private dataDue = 0;
  private dataWork: Promise<void> | null = null;
  constructor(private readonly options: PictureServiceOptions) {
    this.now = options.now ?? Date.now;
    this.queue = new PictureQueue({ db: metadataDb(), now: this.now, available: () => this.rendererReady,
      capacity: () => Math.max(1, limits.exportRenderConcurrency - 1),
      building: mapId => !!metadataDb().prepare("SELECT 1 FROM layer_tiles t JOIN layers l ON l.id = t.layer_id WHERE l.map_id = ? AND l.visible = 1 AND t.state = 'building'").get(mapId),
      run: async state => {
        try { await (options.run ?? (state => this.render(state)))(state); }
        catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "render_unavailable") {
            if (!this.options.available) pictureRendererFailed();
            this.rendererFailed = true;
            this.rendererReady = false;
          }
          throw error;
        }
      },
    });
  }
  async look(): Promise<void> {
    if (!this.options.available) retryPictureRenderer();
    this.rendererFailed = false;
    this.rendererReady = (this.options.available ?? pictureRendererAvailable)();
    const maps = metadataDb().prepare("SELECT m.id, m.updated_at FROM maps m JOIN accounts a ON a.id = m.owner_id WHERE a.status = 'active' ORDER BY m.updated_at DESC, m.id").all() as { id: string; updated_at: string }[];
    for (const map of maps) {
      try {
        const scope = mapOwnerWorkScope(map.id);
        const { target, inputs: bindings, resolved } = await schedulingBindings(scope, map.id);
        const hasPicture = (await servedThumbnails(scope, [map.id])).has(map.id);
        initializePicture(map.id, target.digest, hasPicture, Date.parse(map.updated_at), metadataDb());
        let state = requestPicture(map.id, target.digest, this.now(), bindingsChanged(map.id, bindings, resolved));
        rememberBindings(map.id, bindings, resolved);
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
    const { target, inputs, resolved } = await schedulingBindings(scope, mapId);
    this.rendererReady = !this.rendererFailed && (this.options.available ?? pictureRendererAvailable)();
    const state = requestPicture(mapId, target.digest, this.now(), force || bindingsChanged(mapId, inputs, resolved));
    rememberBindings(mapId, inputs, resolved);
    this.queue.tick();
    return getPictureState(mapId) ?? state;
  }
  async refresh(mapId: string): Promise<PictureState> {
    const pending = getPictureState(mapId);
    return this.request(mapId, pending?.state !== "waiting" && pending?.state !== "unavailable");
  }
  async adopt(mapId: string): Promise<void> {
    const scope = mapOwnerWorkScope(mapId);
    const { target, inputs, resolved } = await schedulingBindings(scope, mapId);
    if ((await servedThumbnails(scope, [mapId])).has(mapId)) { adoptPicture(mapId, target.digest, this.now()); rememberBindings(mapId, inputs, resolved); }
    else await this.request(mapId);
  }
  dataChanged(datasetId: string): void {
    const now = this.now();
    if (!this.dataIds.size) this.dataStartedAt = now;
    this.dataIds.add(datasetId);
    this.dataDue = Math.min(now + 5000, this.dataStartedAt + 60000);
  }
  async tick(): Promise<void> {
    if (!this.dataWork && this.dataIds.size && this.now() >= this.dataDue) {
      const ids = this.dataIds; this.dataIds = new Set();
      this.dataWork = this.resolveDataChanges(ids, this.dataDue - 5000).finally(() => { this.dataWork = null; });
    }
    await this.dataWork;
    this.queue.tick();
  }
  async drain(): Promise<void> { await this.dataWork; await this.queue.drain(); }
  get busy(): boolean { return this.dataWork !== null || this.queue.busy; }
  clearPendingData(): void { this.dataIds.clear(); }
  /** Independent observation for the populated erasure proof. */
  pendingDataIdsForTests(): string[] { return [...this.dataIds]; }
  private async resolveDataChanges(ids: ReadonlySet<string>, changedAt: number): Promise<void> {
    const maps = metadataDb().prepare("SELECT id FROM maps").all() as { id: string }[];
    for (const map of maps) {
      if (!bindingMayUse(map.id, ids)) continue;
      try {
        const { target, inputs, resolved } = await pictureBindings(mapOwnerWorkScope(map.id), map.id);
        requestPicture(map.id, target.digest, changedAt, bindingsChanged(map.id, inputs, resolved));
        rememberBindings(map.id, inputs, resolved);
      } catch { /* A removed map or inactive owner contributes no work. */ }
    }
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
