const key = Symbol.for("dezfil.render-work");
const host = globalThis as typeof globalThis & { [key]?: Map<string, Set<Promise<unknown>>> };
const work = host[key] ??= new Map<string, Set<Promise<unknown>>>();
/** Include physical launch/render/close settlement, even after a response times out. */
export function trackRenderWork<T>(accountId: string, promise: Promise<T>): Promise<T> {
  let entries = work.get(accountId);
  if (!entries) { entries = new Set(); work.set(accountId, entries); }
  entries.add(promise);
  const settled = () => { entries.delete(promise); if (!entries.size) work.delete(accountId); };
  void promise.then(settled, settled);
  return promise;
}
export async function drainAccountRenders(accountId: string): Promise<void> {
  while (work.get(accountId)?.size) await Promise.allSettled([...work.get(accountId)!]);
}
export function renderWorkForTests(accountId: string): number { return work.get(accountId)?.size ?? 0; }
