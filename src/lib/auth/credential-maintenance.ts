import type { Database } from "better-sqlite3";
import { metadataDb } from "@/lib/metadata/db";
import { credentialKinds, credentialPage, CREDENTIAL_PAGE_SIZE, removeExpiredCredentials, type CredentialKind } from "@/lib/metadata/credential-maintenance";

export const CREDENTIAL_SWEEP_INTERVAL_MS = 60 * 60_000;
type Cursors = Record<CredentialKind, string | undefined | null>;

export function credentialMaintenance() {
  let completedAt: number | undefined;
  let cursors: Cursors | undefined;
  return (db: Database, clock: () => number = Date.now) => {
    // Commit-time authority checks also visit credentials. Never nest a sweep
    // inside the caller's transaction, or move its cursor past a rollback.
    if (db.inTransaction) return null;
    const now = clock();
    if (!cursors && completedAt !== undefined && now < completedAt + CREDENTIAL_SWEEP_INTERVAL_MS) return null;
    const next: Cursors = { ...(cursors ?? { sessions: undefined, links: undefined, tokens: undefined }) };
    const examined = { sessions: 0, links: 0, tokens: 0 }, removed = { ...examined };
    for (const kind of credentialKinds) {
      if (next[kind] === null) continue;
      const ids = credentialPage(db, kind, next[kind]);
      examined[kind] = ids.length;
      removed[kind] = removeExpiredCredentials(db, kind, ids, clock());
      next[kind] = ids.length < CREDENTIAL_PAGE_SIZE ? null : ids.at(-1);
    }
    const complete = credentialKinds.every(kind => next[kind] === null);
    cursors = complete ? undefined : next;
    if (complete) completedAt = clock();
    return { examined, removed, complete };
  };
}

type Sweep = ReturnType<typeof credentialMaintenance>;
const key = Symbol.for("dezfil.credential-maintenance");
const shared = process as typeof process & { [key]?: { files: Map<string, Sweep>; memory: WeakMap<Database, Sweep> } };
const state = shared[key] ??= { files: new Map(), memory: new WeakMap() };

/** One coordinator across route bundles, with separate in-memory test stores. */
export function maintainCredentials(db: Database = metadataDb(), now?: number) {
  let sweep = db.memory ? state.memory.get(db) : state.files.get(db.name);
  if (!sweep) {
    sweep = credentialMaintenance();
    if (db.memory) state.memory.set(db, sweep); else state.files.set(db.name, sweep);
  }
  return sweep(db, now === undefined ? Date.now : () => now);
}
