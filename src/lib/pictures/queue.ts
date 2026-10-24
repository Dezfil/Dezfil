import { EvaluationCancelled } from "@/lib/api/errors";
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
  /** Told of each attempt that ends failed, after the row records it,
   * with the request's failures so far; the attempt holds its slot until
   * this settles. */
  failed?(state: PictureState, attemptCount: number): Promise<void> | void;
}
/** Pending work is derived from rows; only admitted attempts occupy memory. */
export class PictureQueue {
  private running = new Map<string, Promise<void>>();
  constructor(private readonly options: PictureQueueOptions) {}
  tick(): void {
    const o = this.options, now = o.now();
    for (const state of listPictureStates(o.db)) {
      if ((state.state === "current" || state.state === "unsupported") || this.running.has(state.mapId)) continue;
      if (!o.available()) {
        if (state.state !== "unavailable") settlePicture(state.mapId, state.requestedGeneration, { state: "unavailable" }, o.db);
        continue;
      }
      if (state.state === "unavailable") {
        settlePicture(state.mapId, state.requestedGeneration, { state: "waiting", nextAttemptAt: now }, o.db);
        state.nextAttemptAt = now;
      }
      if (state.nextAttemptAt > now || o.building(state.mapId)) continue;
      if (this.running.size >= o.capacity()) break;
      const active = o.db.prepare("SELECT 1 FROM maps m JOIN accounts a ON a.id = m.owner_id WHERE m.id = ? AND a.status = 'active'").get(state.mapId);
      if (!active) continue;
      const work = o.run(state).catch(error => {
        if (error instanceof EvaluationCancelled) {
          settlePicture(state.mapId, state.requestedGeneration, { state: "waiting", nextAttemptAt: o.now() }, o.db);
          return;
        }
        const unavailable = error && typeof error === "object" && "code" in error && error.code === "render_unavailable";
        const attemptCount = state.attemptCount + 1;
        const outcome = unavailable ? "unavailable" : error instanceof PictureRenderError ? error.state : "failed";
        const settled = settlePicture(state.mapId, state.requestedGeneration, outcome === "unavailable" ? { state: "unavailable" } : {
          state: outcome,
          attemptCount,
          nextAttemptAt: o.now() + (attemptCount === 1 ? 0 : attemptCount === 2 ? 60000 : attemptCount === 3 ? 600000 : 3600000),
        }, o.db);
        if (settled && outcome === "failed") return o.failed?.(state, attemptCount);
      }).finally(() => { this.running.delete(state.mapId); });
      this.running.set(state.mapId, work);
    }
  }
  async drain(): Promise<void> { await Promise.all([...this.running.values()]); }
  get busy(): boolean { return this.running.size > 0; }
  /** Independent populated-store observation for the erasure proof. */
  runningIdsForTests(): string[] { return [...this.running.keys()]; }
}
