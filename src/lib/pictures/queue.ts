import type { Database } from "better-sqlite3";
import { listPictureStates, settlePicture, type PictureState } from "./state";
import { PictureRenderError } from "./card";
export interface PictureQueueOptions {
  db: Database;
  now(): number;
  available(): boolean;
  building(mapId: string): boolean;
  capacity(): number;
  run(state: PictureState): Promise<void>;
}
/** Pending work is derived from rows; only admitted attempts occupy memory. */
export class PictureQueue {
  private running = new Map<string, Promise<void>>();
  constructor(private readonly options: PictureQueueOptions) {}
  tick(): void {
    const o = this.options, now = o.now();
    for (const state of listPictureStates(o.db)) {
      if (state.state === "current" || this.running.has(state.mapId)) continue;
      if (!o.available()) { settlePicture(state.mapId, state.requestedGeneration, { state: "unavailable" }, o.db); continue; }
      if (state.state === "unavailable") {
        settlePicture(state.mapId, state.requestedGeneration, { state: "waiting", nextAttemptAt: now }, o.db);
        state.nextAttemptAt = now;
      }
      if (state.nextAttemptAt > now || o.building(state.mapId)) continue;
      if (this.running.size >= o.capacity()) break;
      const active = o.db.prepare("SELECT 1 FROM maps m JOIN accounts a ON a.id = m.owner_id WHERE m.id = ? AND a.status = 'active'").get(state.mapId);
      if (!active) continue;
      const work = o.run(state).catch(error => {
        const unavailable = error && typeof error === "object" && "code" in error && error.code === "render_unavailable";
        const attemptCount = state.attemptCount + 1;
        settlePicture(state.mapId, state.requestedGeneration, unavailable ? { state: "unavailable" } : {
          state: error instanceof PictureRenderError ? error.state : "failed",
          attemptCount,
          nextAttemptAt: o.now() + (attemptCount === 1 ? 60000 : attemptCount === 2 ? 600000 : 3600000),
        }, o.db);
      }).finally(() => { this.running.delete(state.mapId); });
      this.running.set(state.mapId, work);
    }
  }
  async drain(): Promise<void> { await Promise.all([...this.running.values()]); }
  get busy(): boolean { return this.running.size > 0; }
}
