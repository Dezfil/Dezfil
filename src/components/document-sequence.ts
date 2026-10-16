import { editHeaders } from "@/lib/edit-basis";

export const STALE_MESSAGE = "This item has changed. Reload it before trying again.";
export const DISCARD_MESSAGE = "Reload discards your unsaved values. Copy what you want to keep first.";

/** A write refused because the person can no longer change this document:
 * it is no longer theirs to reach (removed from its project, or gone), or
 * no longer theirs to change (made a Viewer, or its owner deactivated).
 * Every later write would meet the same refusal. A change to the
 * publication is the owner's alone whatever an editor's standing, so its
 * refusal says nothing about the editor's access; a read that finds
 * nothing is not a refused write. */
function accessEnded(status: number, code: unknown, method: string, path: string): boolean {
  if (method === "GET" || /\/publish(?:[?#]|$)/.test(path)) return false;
  return (status === 403 && code === "forbidden") || (status === 404 && code === "not_found");
}

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
  /** Refused work keeps its old basis until an explicit discard installs a
   * new editor. A stale revision halts the sequence, and so does a write
   * refused because access has ended. */
  async observe(response: Response, method = "GET", path = "") {
    if (response.status === 409 || response.status === 403 || response.status === 404) {
      const body = await response.clone().json().catch(() => null);
      const code = body?.error?.code;
      if ((response.status === 409 && code === "stale_revision") || accessEnded(response.status, code, method, path)) this.halt();
    }
    return response;
  }
  refusal() { return Response.json({ error: { code: "stale_revision", message: STALE_MESSAGE } }, { status: 409 }); }
  writeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (this.stale || this.closed) return this.refusal();
    const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    return this.observe(await fetch(input, { ...init, headers: this.headers(init?.headers) }), init?.method ?? "GET", path);
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
        : current.filter((v) => !old.has(v.id) || next.has(v.id)).map((v) => v.id);
      if (!reordered) {
        // New items retain their place relative to the next surviving item.
        // Appending here changed note stacking when undo restored a removal.
        after.forEach((item, index) => {
          if (old.has(item.id) || byId.has(item.id)) return;
          const anchor = after.slice(index + 1).find((v) => ids.includes(v.id));
          ids.splice(anchor ? ids.indexOf(anchor.id) : ids.length, 0, item.id);
        });
      }
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
