import type { Database } from "better-sqlite3";
import { metadataDb } from "@/lib/metadata/db";
import { resourceAbsent } from "./owned-resource";
import { withStorageRecovery } from "@/lib/system/storage-reserve";

export interface RetainedStore { drain(): Promise<void>; busy(): boolean; clear(): void }
interface Work { database: string; accounts: Set<string>; settled: Promise<void>; cleanups: Set<() => Promise<void>>; released: boolean; retrying?: Promise<void> }
interface Holder { work: Set<Work>; stores: Set<RetainedStore>; generation: number }
const key = Symbol.for("dezfil.account-deletion-admission");
const host = process as typeof process & { [key]?: Holder };
const holder = host[key] ??= { work: new Set<Work>(), stores: new Set<RetainedStore>(), generation: 0 };

/** Stored identity state is authoritative in every page, route and startup
 * bundle. Deactivation keeps shared reads; accepted erasure ends admission. */
export function accountMaterialAvailable(accountId: string | null, db: Database = metadataDb()): boolean {
  if (accountId === null) return true;
  const row = db.prepare("SELECT status FROM accounts WHERE id = ?").get(accountId) as { status: string } | undefined;
  return !!row && row.status !== "deleting" && row.status !== "deleted";
}

export interface AccountWorkLease {
  /** Newly discovered dependencies must be admitted before being consumed. */
  includes(accountId: string | null): boolean;
  bind(accounts: readonly (string | null)[]): void;
  /** Check immediately before a synchronous commit, without an intervening await. */
  assertCommit(): void;
  /** Release after evaluation/stream settlement and candidate cleanup. */
  retainCleanup(cleanup: () => Promise<void>): void;
  release(error?: unknown): void;
}
export function admitAccountWork(accounts: readonly (string | null)[], db: Database = metadataDb()): AccountWorkLease {
  const done = Promise.withResolvers<void>();
  void done.promise.catch(() => {});
  const work: Work = { database: db.name, accounts: new Set<string>(), settled: done.promise, cleanups: new Set(), released: false };
  let released = false;
  const check = (id: string) => { if (!accountMaterialAvailable(id, db)) throw resourceAbsent(); };
  const lease: AccountWorkLease = {
    includes: id => !released && (id === null || work.accounts.has(id)),
    bind(ids) {
      if (released) throw new Error("Work has already settled.");
      for (const id of ids) if (id !== null && !work.accounts.has(id)) check(id);
      for (const id of ids) if (id !== null) work.accounts.add(id);
    },
    assertCommit() { if (released) throw new Error("Work has already settled."); for (const id of work.accounts) check(id); },
    retainCleanup(cleanup) { if (!released) work.cleanups.add(cleanup); },
    release(error) {
      if (released) return;
      released = true; work.released = true;
      if (work.cleanups.size) { done.reject(error ?? new Error("Account work cleanup is unfinished.")); return; }
      holder.work.delete(work); work.accounts.clear();
      if (error === undefined) done.resolve(); else done.reject(error);
    },
  };
  lease.bind(accounts); holder.work.add(work);
  return lease;
}

/** How many pieces of admitted work bound to the account are still held:
 * what a deletion's first stage waits on. */
export function admittedReads(accountId: string, db: Database = metadataDb()): number {
  return [...holder.work].filter(w => w.database === db.name && w.accounts.has(accountId)).length;
}

/** A drain still waiting after this long says so in the server log, once:
 * a consumer that never releases its lease keeps a deletion pending for
 * ever, and nothing else would tell. */
const DRAIN_LOGGED_AFTER_MS = 60_000;

export async function drainAccountWork(accountId: string, db: Database = metadataDb()): Promise<void> {
  const overdue = setTimeout(() => {
    const count = admittedReads(accountId, db);
    if (count > 0) console.warn(`Account deletion has waited ${DRAIN_LOGGED_AFTER_MS / 1000} s for ${count} admitted ${count === 1 ? "read" : "reads"} to settle`);
  }, DRAIN_LOGGED_AFTER_MS);
  try { await drainUntilSettled(accountId, db); } finally { clearTimeout(overdue); }
}

async function drainUntilSettled(accountId: string, db: Database): Promise<void> {
  for (;;) {
    const work = [...holder.work].filter(w => w.database === db.name && w.accounts.has(accountId));
    if (!work.length) return;
    await Promise.all(work.map(w => {
      if (!w.released || !w.cleanups.size) return w.settled;
      // A refused output still owns its failed removal. Later continuation
      // retries that exact cleanup; dropping its lookup is never settlement.
      return w.retrying ??= (async () => {
        const results = await Promise.allSettled([...w.cleanups].map(cleanup => withStorageRecovery(cleanup)));
        const failed = results.find(result => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
        w.cleanups.clear(); w.accounts.clear(); holder.work.delete(w);
      })().finally(() => { w.retrying = undefined; });
    }));
  }
}
export function registerRetainedStore(store: RetainedStore): void { holder.stores.add(store); }
export function retentionGeneration(): number { return holder.generation; }
export async function purgeRetainedStores(): Promise<void> {
  holder.generation++;
  for (;;) {
    const stores = [...holder.stores]; await Promise.all(stores.map(s => s.drain()));
    if (stores.length !== holder.stores.size || stores.some(s => s.busy())) continue;
    for (const store of stores) store.clear();
    return;
  }
}
