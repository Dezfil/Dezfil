import type { HomeState, ProjectRecordWire } from "./home-read";

export interface HomeVisit { id: string }
export type HomeField = "name" | "note";
export interface HomeAction {
  visit: HomeVisit;
  generation: number;
}
export interface HomeSave extends HomeAction {
  field: HomeField;
  sequence: number;
}
export type HomeFetcher = (id: string) => Promise<HomeState>;
export interface HomeSnapshot { visit: HomeVisit | null; state: HomeState }

/** The production home response coordinator. The injected composite fetcher
 * lets tests release actual read results without replacing React's hooks. */
export class ProjectHomeReader {
  private snapshot: HomeSnapshot = { visit: null, state: { status: "pending" } };
  private generation = 0;
  private sequence = 0;
  private readSequence = 0;
  private revision = 0;
  private accepted: Record<HomeField, number> = { name: 0, note: 0 };
  private listeners = new Set<() => void>();
  private waiters = new Set<(installed: boolean) => void>();
  private issuedRevision = -1;

  constructor(private readonly fetcher: HomeFetcher) {}

  getSnapshot = (): HomeSnapshot => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(state: HomeState) {
    this.snapshot = { ...this.snapshot, state };
    for (const listener of this.listeners) listener();
  }

  activate(visit: HomeVisit): Promise<boolean> {
    this.settle(false);
    this.generation++;
    this.accepted = { name: 0, note: 0 };
    this.snapshot = { visit, state: { status: "pending" } };
    return this.retry(visit);
  }

  dispose(visit: HomeVisit) {
    if (this.snapshot.visit !== visit) return;
    this.generation++;
    this.settle(false);
    this.snapshot = { visit: null, state: { status: "pending" } };
  }

  retry(visit: HomeVisit): Promise<boolean> {
    if (this.snapshot.visit !== visit) return Promise.resolve(false);
    if (this.snapshot.state.status !== "ready") this.publish({ status: "pending" });
    return this.request(visit, false);
  }

  refresh(visit: HomeVisit): Promise<boolean> {
    if (this.snapshot.visit !== visit) return Promise.resolve(false);
    return this.request(visit, true);
  }

  private request(visit: HomeVisit, quiet: boolean): Promise<boolean> {
    const result = new Promise<boolean>((resolve) => this.waiters.add(resolve));
    void this.read(visit, quiet);
    return result;
  }

  /** Waiters follow the current read, including replacement reads. An older
   * transport's result says nothing about whether the current home installed. */
  private async read(visit: HomeVisit, quiet: boolean): Promise<void> {
    const generation = this.generation;
    const read = ++this.readSequence;
    const revision = this.revision;
    this.issuedRevision = revision;
    const state = await this.fetcher(visit.id);
    if (!this.ownsRead(visit, generation, read, revision)) return;
    const waiters = this.waiters;
    this.waiters = new Set();
    if (state.status === "ready" || !quiet || this.snapshot.state.status !== "ready") {
      this.publish(state);
    }
    for (const resolve of waiters) resolve(state.status === "ready");
  }

  private settle(installed: boolean) {
    const waiters = this.waiters;
    this.waiters = new Set();
    for (const resolve of waiters) resolve(installed);
  }

  /** Coalesce confirmations in one turn. A newer explicit read already owns
   * the replacement if it was issued at the current confirmed revision. */
  private replaceSupersededRead(visit: HomeVisit) {
    const generation = this.generation;
    if (this.waiters.size === 0) return;
    queueMicrotask(() => {
      if (this.snapshot.visit !== visit || generation !== this.generation ||
          this.waiters.size === 0 || this.issuedRevision === this.revision) return;
      void this.read(visit, true);
    });
  }

  private ownsRead(visit: HomeVisit, generation: number, read: number, revision: number) {
    return this.snapshot.visit === visit && generation === this.generation &&
      read === this.readSequence && revision === this.revision;
  }

  beginSave(visit: HomeVisit, field: HomeField): HomeSave {
    return { ...this.beginAction(visit), field, sequence: ++this.sequence };
  }

  beginAction(visit: HomeVisit): HomeAction {
    return { visit, generation: this.generation };
  }

  ownsAction(action: HomeAction): boolean {
    return this.snapshot.visit === action.visit && this.generation === action.generation;
  }

  ownsSave(save: HomeSave): boolean {
    return this.ownsAction(save) && save.sequence >= this.accepted[save.field];
  }

  acceptSave(save: HomeSave, record: ProjectRecordWire): boolean {
    if (!this.ownsSave(save)) return false;
    const state = this.snapshot.state;
    if (state.status !== "ready") return false;
    this.accepted[save.field] = save.sequence;
    this.revision++;
    const current = state.value.record;
    this.publish({
      status: "ready",
      value: {
        ...state.value,
        record: {
          ...current,
          [save.field]: record[save.field],
          createdAt: record.createdAt > current.createdAt ? record.createdAt : current.createdAt,
          updatedAt: record.updatedAt > current.updatedAt ? record.updatedAt : current.updatedAt,
        },
      },
    });
    this.replaceSupersededRead(save.visit);
    return true;
  }

  confirmMembership(visit: HomeVisit): Promise<boolean> {
    if (this.snapshot.visit !== visit) return Promise.resolve(false);
    // Fence immediately, before the follow-up can yield to an older read.
    this.revision++;
    return this.refresh(visit);
  }
}
