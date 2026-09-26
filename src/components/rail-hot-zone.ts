// The rail's hot zone by page. The two-thirds rule was written for the
// map builder, where the rail sits against the inspector card and a
// pointer travelling to that card crosses the rail on the way: the right
// third is a corridor, not a target. Off the builder there is no panel
// against the rail and nothing to cross toward, so the whole collapsed
// rail is the hot zone. The dwell is the shell's and holds on every page;
// only where a rest counts changes here.

/** Share of the collapsed rail's width that initiates expansion on the
 * map builder: the left two-thirds. */
export const BUILDER_HOT_ZONE = 2 / 3;
/** Everywhere else: the whole rail. */
export const WHOLE_RAIL = 1;

/** The map builder is the map detail route and only that (`/maps/<id>`);
 * the maps gallery, which shares the prefix, is not the builder. */
export function isBuilderPath(pathname: string): boolean {
  return /^\/maps\/[^/]+\/?$/.test(pathname);
}

/** The hot zone for the page at `pathname`, as a share of the rail's width. */
export function hotZoneShare(pathname: string): number {
  return isBuilderPath(pathname) ? BUILDER_HOT_ZONE : WHOLE_RAIL;
}
