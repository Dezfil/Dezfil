import type { Database } from "better-sqlite3";
import { metadataDb } from "./metadata/db";
import { instanceCounts } from "./instance-limits";
import { countLimitValues, tokenLifetimeMax } from "./settings/instance-limit-values";
import { readStoredSettings } from "./settings/store";

/** Aggregate counts disclose no private resource or account identities. */
export function readInstanceLimits(db: Database = metadataDb()) {
  return db.transaction(() => {
    const counts = instanceCounts(db), limits = countLimitValues(db);
    return {
      maps: { key: "mapsLimit", limit: limits.maps, count: counts.maps },
      projects: { key: "projectsLimit", limit: limits.projects, count: counts.projects },
      people: { key: "peopleLimit", limit: limits.people, count: counts.people },
      tokenLifetimeMax: tokenLifetimeMax(readStoredSettings(db)).value,
    };
  })();
}
