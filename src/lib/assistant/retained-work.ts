import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
interface Work { controller: AbortController; done: Promise<void>; finish(): void; abort?: () => void }
interface Store { interrupt?(accountId: string): void; erase(accountId: string): void }
const key = Symbol.for("dezfil.assistant-retained-work");
const host = globalThis as typeof globalThis & { [key]?: { work: Map<string, Set<Work>>; cleanups: Map<string, Set<() => void>>; stores: Set<Store> } };
const holder = host[key] ??= { work: new Map<string, Set<Work>>(), cleanups: new Map<string, Set<() => void>>(), stores: new Set<Store>() };
/** Stores retain their own module's scope validator. Only raw cleanup identities
 * and completion promises cross compiled module graphs. */
export function registerAssistantStore(store: Store): void { holder.stores.add(store); }
export function retainAssistantCleanup(accountId: string, cleanup: () => void): () => void {
  let entries = holder.cleanups.get(accountId); if (!entries) holder.cleanups.set(accountId, entries = new Set()); entries.add(cleanup);
  return () => { cleanup(); entries.delete(cleanup); if (!entries.size) holder.cleanups.delete(accountId); };
}
export function beginAssistantWork(scope: AccountScope, abort?: () => void) {
  const accountId = requireAccountScope(scope), settled = Promise.withResolvers<void>(), controller = new AbortController();
  let entries = holder.work.get(accountId); if (!entries) holder.work.set(accountId, entries = new Set());
  const entry: Work = { controller, done: settled.promise, abort, finish() { entries.delete(entry); if (!entries.size) holder.work.delete(accountId); settled.resolve(); } };
  entries.add(entry); return { signal: controller.signal, finish: entry.finish };
}
export async function drainAssistantWork(accountId: string): Promise<void> {
  for (const store of holder.stores) store.interrupt?.(accountId);
  for (;;) {
    const work = [...(holder.work.get(accountId) ?? [])]; if (!work.length) break;
    for (const entry of work) { entry.controller.abort(new DOMException("Account is inactive", "AbortError")); entry.abort?.(); }
    await Promise.all(work.map(entry => entry.done));
  }
  for (const cleanup of holder.cleanups.get(accountId) ?? []) cleanup();
  holder.cleanups.delete(accountId);
  for (const store of holder.stores) store.erase(accountId);
}
export function assistantWorkForTests(accountId: string) { return { work: holder.work.get(accountId)?.size ?? 0, cleanups: holder.cleanups.get(accountId)?.size ?? 0 }; }
