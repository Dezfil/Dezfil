import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
interface Work { begun: number; controller: AbortController; done: Promise<void>; finish(): void; abort?: () => void }
interface Cleanup { begun: number; cleanup(): void }
interface Store { interrupt?(accountId: string): void; erase(accountId: string): void; endBefore?(mark: number): void }
const key = Symbol.for("dezfil.assistant-retained-work");
const host = globalThis as typeof globalThis & { [key]?: { sequence: number; endedBefore: number; work: Map<string, Set<Work>>; cleanups: Map<string, Set<Cleanup>>; stores: Set<Store> } };
const holder = host[key] ??= { sequence: 0, endedBefore: 0, work: new Map<string, Set<Work>>(), cleanups: new Map<string, Set<Cleanup>>(), stores: new Set<Store>() };
/** A process-local ordering, independent of wall-clock changes and shared by bundles. */
export function assistantBeginMark(): number { return ++holder.sequence; }
export function assistantWorkEnded(mark: number): boolean { return mark < holder.endedBefore; }
/** Stores retain their own module's scope validator. Only raw cleanup identities
 * and completion promises cross compiled module graphs. */
export function registerAssistantStore(store: Store): void { holder.stores.add(store); }
export function retainAssistantCleanup(accountId: string, cleanup: () => void): () => void {
  let entries = holder.cleanups.get(accountId); if (!entries) holder.cleanups.set(accountId, entries = new Set());
  const entry = { begun: assistantBeginMark(), cleanup }; entries.add(entry);
  return () => { cleanup(); entries.delete(entry); if (!entries.size) holder.cleanups.delete(accountId); };
}
export function beginAssistantWork(scope: AccountScope, abort?: () => void, begun = assistantBeginMark()) {
  const accountId = requireAccountScope(scope), settled = Promise.withResolvers<void>(), controller = new AbortController();
  let entries = holder.work.get(accountId); if (!entries) holder.work.set(accountId, entries = new Set());
  const entry: Work = { begun, controller, done: settled.promise, abort, finish() { entries.delete(entry); if (!entries.size) holder.work.delete(accountId); settled.resolve(); } };
  entries.add(entry);
  if (assistantWorkEnded(begun)) { controller.abort(new DOMException("Credentials ended", "AbortError")); abort?.(); }
  return { begun, signal: controller.signal, finish: entry.finish };
}
/** Interrupt synchronously; settlement waits only for the captured older work.
 * A newly authenticated turn may begin while an old provider is unwinding. */
export async function endAssistantWorkBefore(mark: number): Promise<void> {
  holder.endedBefore = Math.max(holder.endedBefore, mark);
  const work = [...holder.work.values()].flatMap(entries => [...entries].filter(entry => entry.begun < mark));
  for (const store of holder.stores) store.endBefore?.(mark);
  for (const entry of work) { entry.controller.abort(new DOMException("Credentials ended", "AbortError")); entry.abort?.(); }
  await Promise.all(work.map(entry => entry.done));
  for (const [id, entries] of holder.cleanups) {
    for (const entry of entries) if (entry.begun < mark) { entry.cleanup(); entries.delete(entry); }
    if (!entries.size) holder.cleanups.delete(id);
  }
}
export async function drainAssistantWork(accountId: string): Promise<void> {
  for (const store of holder.stores) store.interrupt?.(accountId);
  for (;;) {
    const work = [...(holder.work.get(accountId) ?? [])]; if (!work.length) break;
    for (const entry of work) { entry.controller.abort(new DOMException("Account is inactive", "AbortError")); entry.abort?.(); }
    await Promise.all(work.map(entry => entry.done));
  }
  for (const entry of holder.cleanups.get(accountId) ?? []) entry.cleanup();
  holder.cleanups.delete(accountId);
  for (const store of holder.stores) store.erase(accountId);
}
export function assistantWorkForTests(accountId: string) { return { work: holder.work.get(accountId)?.size ?? 0, cleanups: holder.cleanups.get(accountId)?.size ?? 0 }; }
