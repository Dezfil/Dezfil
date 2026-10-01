import type { Database } from "better-sqlite3";
import type { AccountScope } from "@/lib/auth/scope";
import { reachableProjectIds, requireReachable } from "@/lib/auth/reach";
import { resourceAbsent } from "@/lib/auth/owned-resource";
import { accountLabels, type AccountLabel } from "@/lib/metadata/accounts";
import { metadataDb } from "@/lib/metadata/db";
import { mapStanding, type MapStanding } from "@/lib/metadata/map-queries";

/**
 * What a reached map or workflow carries beyond its stored record: the
 * project it is filed in when the caller reaches that project (null
 * otherwise, so a response never names a project its caller cannot reach),
 * its owner, and its SQL home, the account whose space its SQL binds in.
 * One's own resources carry the same fields, the owner being the caller, so
 * a client never special-cases them.
 */
export interface Presence {
  projectId: string | null;
  owner: AccountLabel;
  /** The SQL name of the home account. */
  home: string;
}

/** The presences of several admitted resources, in order: one read of the
 * caller's projects and one of the accounts named. */
export function presencesOf(scope: AccountScope, standings: readonly MapStanding[], db: Database = metadataDb()): Presence[] {
  if (standings.length === 0) return [];
  const projects = reachableProjectIds(scope, db);
  const labels = accountLabels(standings.flatMap(s => [s.ownerId, s.homeId]), db);
  return standings.map(standing => {
    const owner = labels.get(standing.ownerId);
    // A home is stamped from the creator; an unstamped one is its owner's.
    const home = labels.get(standing.homeId ?? standing.ownerId);
    if (!owner || !home) throw resourceAbsent();
    return {
      projectId: standing.projectId !== null && projects.has(standing.projectId) ? standing.projectId : null,
      owner,
      home: home.sqlName,
    };
  });
}

/** A map's presence, for a caller who reaches it; else the absent refusal. */
export function mapPresence(scope: AccountScope, mapId: string, db: Database = metadataDb()): Presence {
  requireReachable(scope, "map", mapId, db);
  const standing = mapStanding(mapId, db);
  if (!standing) throw resourceAbsent();
  return presencesOf(scope, [standing], db)[0];
}
