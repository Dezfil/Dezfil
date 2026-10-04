import { registerQueryStore } from "@/lib/query/retained";
import { dataDir } from "@/lib/config";
import type { DataTable } from "@/lib/metadata/tables";

/** Stored artifacts are immutable. Share both running and completed reads,
 * replacing a dataset's entry on its next artifact. Bound retained datasets
 * so inspecting a catalog does not accumulate every candidate list forever. */
export function inspectionCache<T>() {
  const entries = new Map<string, { file: string; value: Promise<T> }>();
  const pending = new Set<Promise<T>>();
  registerQueryStore({ drain: async () => { await Promise.allSettled([...pending]); }, busy: () => pending.size > 0, clear: () => entries.clear() });
  const inspect = (table: DataTable, read: () => Promise<T>): Promise<T> => {
    const key = JSON.stringify([dataDir(), table.id]);
    let entry = entries.get(key);
    if (entry?.file !== table.file) {
      const value = read();
      pending.add(value); void value.then(() => pending.delete(value), () => pending.delete(value));
      entry = { file: table.file, value };
      entries.set(key, entry);
      void value.catch(() => { if (entries.get(key)?.value === value) entries.delete(key); });
    }
    // Least recently used, including the pending answer. No time-based expiry.
    entries.delete(key);
    entries.set(key, entry);
    if (entries.size > 64) entries.delete(entries.keys().next().value!);
    return entry.value.then(value => structuredClone(value));
  };
  return Object.assign(inspect, { entriesForTests: () => [...entries.keys()], pendingForTests: () => pending.size });
}
