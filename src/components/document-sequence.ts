import { editHeaders } from "@/lib/edit-basis";

/** One editor lifetime and one accepted revision. Camera persistence never
 * enters this sequence. Work builds its payload only when its turn starts. */
export class DocumentSequence {
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(readonly documentId?: string) {}
  revision: string | null = null;
  accept(value: unknown) {
    if (this.closed || !value || typeof value !== "object") return;
    const revision = (value as { editRevision?: unknown }).editRevision;
    if (typeof revision === "string") this.revision = revision;
  }
  headers(initial?: HeadersInit) {
    return this.revision ? editHeaders({ editRevision: this.revision }, initial) : new Headers(initial);
  }
  enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => {
      if (this.closed) throw new Error("This editor is closed.");
      return work();
    });
    this.tail = result.catch(() => undefined);
    return result;
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
