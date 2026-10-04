/** Each compiled module copy registers its actual stores. Cleanup waits for
 * physical settlement and clears synchronously only when every holder is idle. */
export interface RetainedQueryStore { drain(): Promise<void>; busy(): boolean; clear(): void }
const key = Symbol.for("dezfil.query-retained-stores");
const host = globalThis as typeof globalThis & { [key]?: { generation: number; stores: Set<RetainedQueryStore> } };
const holder = host[key] ??= { generation: 0, stores: new Set<RetainedQueryStore>() };
export function registerQueryStore(store: RetainedQueryStore): void { holder.stores.add(store); }
export function queryRetentionGeneration(): number { return holder.generation; }
export async function purgeQueryStores(): Promise<void> {
  holder.generation++;
  for (;;) {
    const stores = [...holder.stores]; await Promise.all(stores.map(s => s.drain()));
    if (stores.length !== holder.stores.size || stores.some(s => s.busy())) continue;
    // No await between the idle check and clearing: a new reader sees the
    // fresh generation, while earlier readers have finished once.
    for (const store of stores) store.clear();
    return;
  }
}
