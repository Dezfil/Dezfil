import type { Database } from "better-sqlite3";
import type { AccountScope } from "@/lib/auth/scope";
import { reachableProjectIds, requireReachable } from "@/lib/auth/reach";
import { resourceAbsent } from "@/lib/auth/owned-resource";
import { accountPeople, accountSqlNames, type PersonLabel } from "@/lib/metadata/accounts";
import { metadataDb } from "@/lib/metadata/db";
import { mapStanding, type MapStanding } from "@/lib/metadata/map-queries";

/**
 * What a reached map or workflow carries beyond its stored record: the
 * project it is filed in, its owner, and its SQL home, the account whose
 * space its SQL binds in. The project is named by its identity when the
 * caller reaches that project, and on the caller's own resource always: a
 * resource's filing is a fact about the resource, and its owner withdraws
 * it by that identity even from a project they were removed from. Anyone
 * else is never told of a project they cannot reach. One's own resources
 * carry the same fields, the owner being the caller, so a client never
 * special-cases them.
 */
export interface Presence {
  projectId: string | null;
  owner: PersonLabel;
  /** The SQL name of the home account. */
  home: string;
}

/** The presences of several admitted resources, in order: one read of the
 * caller's projects and one of the accounts named. */
export function presencesOf(scope: AccountScope, standings: readonly MapStanding[], db: Database = metadataDb()): Presence[] {
  if (standings.length === 0) return [];
  const projects = reachableProjectIds(scope, db);
  const labels = accountPeople(standings.map(s => s.ownerId), db);
  const homes = accountSqlNames(standings.map(s => s.homeId ?? s.ownerId), db);
  return standings.map(standing => {
    const owner = labels.get(standing.ownerId);
    // A home is stamped from the creator; an unstamped one is its owner's.
    const home = homes.get(standing.homeId ?? standing.ownerId);
    if (!owner || !home) throw resourceAbsent();
    const told = standing.projectId !== null && (standing.ownerId === scope.accountId || projects.has(standing.projectId));
    return {
      projectId: told ? standing.projectId : null,
      owner,
      home,
    };
  });
}

/**
 * A map's presence also withholds its publication's token from everyone but
 * the map's owner. The token is the link: holding it is being able to hand
 * the map out, and handing it out is the owner's act. Everyone who reaches
 * the map still reads that it is published, and since when, from the map
 * record. Every map response spreads this over the record, so the token is
 * null there for anyone else.
 */
export type MapPresence = Presence & { publishToken?: null };

/** The presences of several admitted maps, in order. */
export function mapPresencesOf(scope: AccountScope, standings: readonly MapStanding[], db: Database = metadataDb()): MapPresence[] {
  return presencesOf(scope, standings, db).map((presence, i) =>
    standings[i].ownerId === scope.accountId ? presence : { ...presence, publishToken: null });
}

/** A map's presence, for a caller who reaches it; else the absent refusal. */
export function mapPresence(scope: AccountScope, mapId: string, db: Database = metadataDb()): MapPresence {
  requireReachable(scope, "map", mapId, db);
  const standing = mapStanding(mapId, db);
  if (!standing) throw resourceAbsent();
  return mapPresencesOf(scope, [standing], db)[0];
}
