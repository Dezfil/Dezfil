import { registerQueryStore } from "./query/retained";
import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { AccountScope } from "./auth/scope";
import { metadataDb } from "./metadata/db";
import type { HistoryStep } from "./metadata/history";
import { mapEvaluation } from "./query/context";
import { namespaceFor } from "./query/namespace";
import { admitMapSql, savesAsOwner } from "./save-admission";

const LIMIT = 128;
const pending = new Set<Promise<void>>();
let caches = new WeakMap<Database, Map<string, Promise<void>>>();

/** Presentation-only admission reuse. Replay still performs its own admission.
 * Permissions are checked by the caller on every read. Dataset reach, names,
 * artifacts and schema metadata participate because they can change without
 * advancing the map's revision. Failures are never retained. */
async function admitHistoryTargetWork(scope: AccountScope, mapId: string, revision: string,
  steps: HistoryStep[], direction: "undo" | "redo"): Promise<void> {
  const sql = steps.flatMap(step => {
    const image = direction === "undo" ? step.before : step.after;
    return step.scope === "layer" && typeof image?.sql === "string" ? [image.sql] : [];
  });
  if (!sql.length || savesAsOwner(scope, "map", mapId)) return;
  const db = metadataDb();
  let cache = caches.get(db);
  if (!cache) { cache = new Map(); caches.set(db, cache); }
  const keyOf = () => {
    const namespace = namespaceFor(mapEvaluation(scope, mapId, db), db);
    return createHash("sha256").update(JSON.stringify([scope.accountId, mapId, revision, direction,
      steps.map(step => step.id), sql, namespace.home, namespace.datasets])).digest("hex");
  };
  const key = keyOf();
  const known = cache.get(key);
  if (known) return known;
  const admission = (async () => {
    for (const query of new Set(sql)) await admitMapSql(scope, mapId, query);
  })();
  cache.set(key, admission);
  if (cache.size > LIMIT) cache.delete(cache.keys().next().value!);
  try {
    await admission;
    // Do not retain a result if its namespace changed during evaluation.
    if (keyOf() !== key && cache.get(key) === admission) cache.delete(key);
  } catch (error) {
    if (cache.get(key) === admission) cache.delete(key);
    throw error;
  }
}

registerQueryStore({ drain: async () => { await Promise.allSettled([...pending]); }, busy: () => pending.size > 0, clear: () => { caches = new WeakMap(); } });
export function historyAdmissionsForTests(db: Database): number { return caches.get(db)?.size ?? 0; }

export function admitHistoryTarget(...args: Parameters<typeof admitHistoryTargetWork>): ReturnType<typeof admitHistoryTargetWork> {
  const work = admitHistoryTargetWork(...args); pending.add(work);
  void work.then(() => pending.delete(work), () => pending.delete(work)); return work;
}
export function historyPendingForTests(): number { return pending.size; }
