import { editHeaders } from "@/lib/edit-basis";

export const STALE_MESSAGE = "This item has changed. Reload it before trying again.";
export const DISCARD_MESSAGE = "Reload discards your unsaved values. Copy what you want to keep first.";

/** One editor lifetime and one accepted revision. Camera persistence never
 * enters this sequence. Work builds its payload only when its turn starts. */
export class DocumentSequence {
  private tail: Promise<unknown> | null = null;
  private waiting = 0;
  get pending() { return this.waiting > 0; }
  idle = async () => { while (this.tail) await this.tail; };
  private closed = false;
  get disposed() { return this.closed; }
  stale = false;
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.stale;
  halt() { this.stale = true; this.listeners.forEach((listener) => listener()); }
  /** Refused work keeps its old basis until an explicit discard installs a new editor. */
  async observe(response: Response) {
    if (response.status === 409) {
      const body = await response.clone().json().catch(() => null);
      if (body?.error?.code === "stale_revision") this.halt();
    }
    return response;
  }
  refusal() { return Response.json({ error: { code: "stale_revision", message: STALE_MESSAGE } }, { status: 409 }); }
  writeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (this.stale || this.closed) return this.refusal();
    return this.observe(await fetch(input, { ...init, headers: this.headers(init?.headers) }));
  };
  constructor(readonly documentId?: string) {}
  revision: string | null = null;
  accept(value: unknown) {
    if (this.closed || this.stale || !value || typeof value !== "object") return;
    const revision = (value as { editRevision?: unknown }).editRevision;
    if (typeof revision === "string") this.revision = revision;
  }
  headers(initial?: HeadersInit) {
    return this.revision ? editHeaders({ editRevision: this.revision }, initial) : new Headers(initial);
  }
  enqueue<T>(work: () => Promise<T>): Promise<T> {
    const execute = () => {
      if (this.closed) return Promise.reject<T>(new Error("This editor is closed."));
      try { return work(); } catch (error) { return Promise.reject<T>(error); }
    };
    this.waiting++;
    const result = this.tail ? this.tail.then(execute) : execute();
    const settled = result.finally(() => { this.waiting--; if (this.tail === tail) this.tail = null; });
    const tail = settled.catch(() => undefined);
    this.tail = tail;
    return settled;
  }
  dispose() { this.closed = true; }
}

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => !!value && typeof value === "object" && !Array.isArray(value);
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const identified = (value: unknown[]): value is (RecordValue & { id: string })[] => value.every((v) => record(v) && typeof v.id === "string");

/** Capture a field change relative to the displayed value, then apply only
 * those changes to the accepted predecessor. IDs preserve unrelated widget
 * edits and additions; discriminator changes replace their entire variant. */
export function fieldIntent<T>(before: T, after: T): (accepted: T) => T {
  if (equal(before, after)) return (accepted) => accepted;
  if (Array.isArray(before) && Array.isArray(after) && identified(before) && identified(after)) {
    const old = new Map(before.map((v) => [v.id, v]));
    const next = new Map(after.map((v) => [v.id, v]));
    const edits = new Map(after.map((v) => [v.id, fieldIntent(old.get(v.id), v)]));
    const reordered = !equal(before.filter((v) => next.has(v.id)).map((v) => v.id), after.filter((v) => old.has(v.id)).map((v) => v.id));
    return (accepted) => {
      const current = Array.isArray(accepted) && identified(accepted) ? accepted : before;
      const byId = new Map(current.map((v) => [v.id, v]));
      const ids = reordered ? [...after.map((v) => v.id), ...current.filter((v) => !old.has(v.id) && !next.has(v.id)).map((v) => v.id)]
        : [...current.filter((v) => !old.has(v.id) || next.has(v.id)).map((v) => v.id), ...after.filter((v) => !byId.has(v.id) && !old.has(v.id)).map((v) => v.id)];
      return ids.flatMap((id) => {
        // An accepted deletion is not undone by an old widget snapshot.
        if (old.has(id) && !byId.has(id)) return [];
        return edits.has(id) ? [edits.get(id)!(byId.get(id))] : [byId.get(id)];
      }) as T;
    };
  }
  if (record(before) && record(after) && before.type === after.type) {
    const removed = Object.keys(before).filter((key) => !Object.hasOwn(after, key));
    const edits = Object.entries(after).filter(([key, value]) => !equal(before[key], value))
      .map(([key, value]) => [key, fieldIntent(before[key], value)] as const);
    return (accepted) => {
      const result: RecordValue = { ...(record(accepted) ? accepted : before) };
      for (const key of removed) delete result[key];
      for (const [key, apply] of edits) result[key] = apply(result[key]);
      return result as T;
    };
  }
  return () => after;
}

/** PATCH composition retains only the submitted top-level fields. */
export function patchIntent<T extends object>(before: T | null | undefined, patch: Record<string, unknown>): (accepted: T | null) => Record<string, unknown> {
  const entries = Object.entries(patch).map(([key, value]) => [key, fieldIntent((before as RecordValue | null)?.[key], value)] as const);
  return (accepted) => Object.fromEntries(entries.map(([key, apply]) => [key, apply((accepted as RecordValue | null)?.[key])]));
}
