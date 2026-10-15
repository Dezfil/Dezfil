import { sharedTrustedWork } from "@/lib/trusted-shared";
import { registerQueryStore } from "@/lib/query/retained";
import { dataDir } from "@/lib/config";
import type { DataTable } from "@/lib/metadata/tables";

/** Stored artifacts are immutable. Share both running and completed reads,
 * replacing a dataset's entry on its next artifact. Bound retained datasets
 * so inspecting a catalog does not accumulate every candidate list forever. */
export function inspectionCache<T>() {
  const entries = new Map<string, { file: string; value: Promise<T>; shared: ReturnType<typeof sharedTrustedWork<T>> }>();
  const pending = new Set<Promise<void>>();
  registerQueryStore({ drain: async () => { await Promise.allSettled([...pending]); }, busy: () => pending.size > 0, clear: () => entries.clear() });
  const inspect = (table: DataTable, read: () => Promise<T>): Promise<T> => {
    const key = JSON.stringify([dataDir(), table.id]);
    let entry = entries.get(key);
    let value: Promise<T>;
    if (entry?.file !== table.file) {
      const shared = sharedTrustedWork({ kind: "interactive-read", name: "Geometry inspection" }, read);
      value = shared.join();
      pending.add(shared.drained); void shared.drained.then(() => pending.delete(shared.drained));
      entry = { file: table.file, value: shared.value, shared };
      entries.set(key, entry);
      void shared.value.catch(() => { if (entries.get(key)?.value === shared.value) entries.delete(key); });
    } else {
      value = entry.shared.join();
    }
    // Least recently used, including the pending answer. No time-based expiry.
    entries.delete(key);
    entries.set(key, entry);
    if (entries.size > 64) entries.delete(entries.keys().next().value!);
    return value.then(answer => structuredClone(answer));
  };
  return Object.assign(inspect, { entriesForTests: () => [...entries.keys()], pendingForTests: () => pending.size });
}
