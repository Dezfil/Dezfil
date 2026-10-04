import type { Database } from "better-sqlite3";
import { metadataDb } from "@/lib/metadata/db";
import { resourceAbsent } from "./owned-resource";

export interface RetainedStore { drain(): Promise<void>; busy(): boolean; clear(): void }
interface Work { database: string; accounts: Set<string>; settled: Promise<void> }
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
  bind(accounts: readonly (string | null)[]): void;
  /** Check immediately before a synchronous commit, without an intervening await. */
  assertCommit(): void;
  /** Release after evaluation/stream settlement and candidate cleanup. */
  release(): void;
}
export function admitAccountWork(accounts: readonly (string | null)[], db: Database = metadataDb()): AccountWorkLease {
  const done = Promise.withResolvers<void>();
  const work: Work = { database: db.name, accounts: new Set<string>(), settled: done.promise };
  let released = false;
  const check = (id: string) => { if (!accountMaterialAvailable(id, db)) throw resourceAbsent(); };
  const lease: AccountWorkLease = {
    bind(ids) {
      if (released) throw new Error("Work has already settled.");
      for (const id of ids) if (id !== null && !work.accounts.has(id)) check(id);
      for (const id of ids) if (id !== null) work.accounts.add(id);
    },
    assertCommit() { if (released) throw new Error("Work has already settled."); for (const id of work.accounts) check(id); },
    release() { if (!released) { released = true; holder.work.delete(work); work.accounts.clear(); done.resolve(); } },
  };
  lease.bind(accounts); holder.work.add(work);
  return lease;
}

export async function drainAccountWork(accountId: string, db: Database = metadataDb()): Promise<void> {
  for (;;) {
    const work = [...holder.work].filter(w => w.database === db.name && w.accounts.has(accountId));
    if (!work.length) return;
    await Promise.all(work.map(w => w.settled));
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
