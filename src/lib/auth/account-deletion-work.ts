import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { admitAccountWork, type AccountWorkLease } from "./account-deletion-admission";
import type { AccountScope } from "./scope";
import { metadataDb } from "@/lib/metadata/db";

// Only live work is attributed here. Issued private copies keep no new
// dependency evidence; their existing ticket/render lifetime remains decisive.
const key = Symbol.for("dezfil.account-deletion-work-context");
const host = process as typeof process & { [key]?: {
  context: AsyncLocalStorage<readonly AccountWorkLease[]>;
  renderers: Map<string, Set<AccountWorkLease>>;
} };
const holder = host[key] ??= { context: new AsyncLocalStorage<readonly AccountWorkLease[]>(), renderers: new Map<string, Set<AccountWorkLease>>() };
export const delegatedWorkKey = (credential: string): string => createHash("sha256").update(credential).digest("hex");
export function bindDeletionInputs(owners: readonly (string | null)[]): void {
  for (const lease of holder.context.getStore() ?? []) lease.bind(owners);
}
export function bindDeletionDatasets(ids: readonly string[]): void {
  const db = metadataDb();
  bindDeletionInputs(ids.map(id => (db.prepare("SELECT owner_id FROM data_tables WHERE id = ?").get(id) as { owner_id: string } | undefined)?.owner_id ?? null));
}
export function inDeletionWork<T>(lease: AccountWorkLease, work: () => T): T {
  return holder.context.run([...(holder.context.getStore() ?? []), lease], work);
}
export function inDelegatedDeletionWork<T>(scope: object, work: () => T): T {
  const workKey = "workKey" in scope && typeof scope.workKey === "string" ? scope.workKey : undefined;
  const leases = workKey ? holder.renderers.get(workKey) : undefined;
  return leases ? holder.context.run([...(holder.context.getStore() ?? []), ...leases], work) : work();
}
export function registerRenderDeletionWork(credential: string, lease: AccountWorkLease): () => void {
  const key = delegatedWorkKey(credential);
  let leases = holder.renderers.get(key);
  if (!leases) { leases = new Set(); holder.renderers.set(key, leases); }
  leases.add(lease);
  return () => { leases.delete(lease); if (!leases.size) holder.renderers.delete(key); };
}
export function admitResourceWork(scope: AccountScope, resources: readonly { table: "maps" | "recipes" | "projects" | "data_tables"; id: string }[]) {
  const db = metadataDb();
  return admitAccountWork([scope.accountId, ...resources.map(resource =>
    (db.prepare(`SELECT owner_id FROM ${resource.table} WHERE id = ?`).get(resource.id) as { owner_id: string } | undefined)?.owner_id ?? null)], db);
}
export function assertDeletionCommit(): void {
  for (const lease of holder.context.getStore() ?? []) lease.assertCommit();
}
export async function copyFileWork<T extends { cleanup(): Promise<void> }>(scope: AccountScope,
  resources: Parameters<typeof admitResourceWork>[1], work: () => Promise<T>): Promise<T> {
  const lease = admitResourceWork(scope, resources);
  let result: T | undefined;
  try {
    result = await inDeletionWork(lease, work);
    lease.assertCommit(); return result;
  } catch (error) { await result?.cleanup(); throw error; }
  finally { lease.release(); }
}
