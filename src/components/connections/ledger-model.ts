/** The Connections ledger's search and sort: the
 * toolbar the reference gives the page, filtering and ordering the
 * entries it already lists. Pure, so the browser test measures the row
 * and this file's own test holds the rules. */

export const CONNECTION_SORTS = ["checked", "name"] as const;
export type ConnectionsSort = (typeof CONNECTION_SORTS)[number];

type Named = { connection: { name: string } };
type Checked = { connection: { name: string; lastCheckedAt: string | null } };

/** Narrows by name, case-insensitively, on the trimmed query; a blank
 * query is no narrowing at all (the same rule as the sibling lists). */
export function filterConnections<T extends Named>(
  list: T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((e) => e.connection.name.toLowerCase().includes(q));
}

/** Recently checked: the latest check first, never-checked last, ties
 * in the ledger's own order (the sort is stable). Name A–Z as on the
 * sibling lists. */
export function sortConnections<T extends Checked>(
  list: T[],
  sort: ConnectionsSort,
): T[] {
  return [...list].sort((a, b) => {
    if (sort === "name") return a.connection.name.localeCompare(b.connection.name);
    const at = a.connection.lastCheckedAt;
    const bt = b.connection.lastCheckedAt;
    if (at === bt) return 0;
    if (at === null) return 1;
    if (bt === null) return -1;
    return bt.localeCompare(at);
  });
}
