import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { ApiError } from "@/lib/api/errors";
import type { DataTable } from "@/lib/metadata/tables";

/**
 * Provenance-unit fence: refresh is single-flight per unit — a table, or
 * an OSM import group as one unit — so overlapping refreshes can no
 * longer strand artifacts. In-process state is authoritative under the
 * one-container single-process model, the same ground the tile builder's
 * fences stand on.
 */

const key = Symbol.for("dezfil.refresh-fences");
const host = globalThis as typeof globalThis & { [key]?: Map<string, ReturnType<typeof Promise.withResolvers<void>>> };
const active = host[key] ??= new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();

/** The unit a table's refresh contends on: OSM members share their group,
 * and so do the tables of a multi-layer URL import. */
export function refreshUnit(scope: AccountScope, table: DataTable): string {
  const owner = requireAccountScope(scope);
  const group = table.sourceParams?.group;
  if (typeof group === "string") {
    if (table.source === "osm") return `osm:${JSON.stringify([owner, group])}`;
    if (table.source === "url") return `url:${JSON.stringify([owner, group])}`;
  }
  return `table:${JSON.stringify([owner, table.id])}`;
}

/** Claim the unit or answer the documented conflict — never a second build. */
export function beginRefresh(unit: string, name: string): void {
  if (active.has(unit)) {
    const scope = unit.startsWith("osm:")
      ? " (an OSM import group refreshes as one unit)"
      : unit.startsWith("url:")
        ? " (a multi-layer import refreshes as one unit)"
        : "";
    throw new ApiError(
      "refresh_in_flight",
      `Table "${name}" is already refreshing${scope}. Retry when the running refresh completes.`,
      409,
    );
  }
  active.set(unit, Promise.withResolvers<void>());
}

export function endRefresh(unit: string): void {
  active.get(unit)?.resolve();
  active.delete(unit);
}

/** Test hook, mirroring the tile builder's reset. */
export function resetRefreshFences(): void {
  for (const entry of active.values()) entry.resolve();
  active.clear();
}

export async function drainAccountRefreshes(accountId: string): Promise<void> {
  const owned = () => [...active].filter(([unit]) => JSON.parse(unit.slice(unit.indexOf(":") + 1))[0] === accountId);
  while (owned().length) await Promise.all(owned().map(([, entry]) => entry.promise));
}

export function refreshFencesForTests(): string[] { return [...active.keys()]; }
