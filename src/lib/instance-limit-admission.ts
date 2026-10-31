import type { Database } from "better-sqlite3";
import { ApiError } from "./api/errors";
import { instanceCounts, type InstanceCounts } from "./instance-limits";
import { countLimitValues } from "./settings/instance-limit-values";
import { settingRemedy } from "./settings/remedy";

const KEYS = { maps: "mapsLimit", projects: "projectsLimit", people: "peopleLimit" } as const;

/** The immediate outer transaction must hold admission through the insert.
 * Resolving from its database snapshot also observes another writer's settings. */
export function admitInstanceCreation(kind: keyof InstanceCounts, db: Database): void {
  if (!db.inTransaction) throw new Error("Instance creation admission requires a write transaction.");
  checkInstanceCreationLimit(kind, db);
}

/** An advisory read before expensive preparation. Creation must still call
 * admitInstanceCreation inside its immediate outer transaction. */
export function checkInstanceCreationLimit(kind: keyof InstanceCounts, db: Database): void {
  const limit = countLimitValues(db)[kind];
  if (limit === 0) return;
  const count = instanceCounts(db)[kind];
  if (count < limit) return;
  const key = KEYS[kind];
  throw new ApiError("instance_limit_reached",
    `This instance holds its limit of ${limit} ${kind}. Delete one, or raise the limit. ${settingRemedy(key)}`,
    409, { key, limit, count });
}
