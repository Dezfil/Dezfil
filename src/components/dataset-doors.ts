/**
 * The doors to a dataset: its page, the SQL console opened on it, its
 * export, and its page with the set-geometry panel open. Each addresses the
 * dataset by the name its reader types for it, the plain name for one's own
 * and `<sql name>.<name>` for someone else's, which the routes accept as
 * they accept an identifier. So a person who reaches someone else's `roads`
 * and owns a `roads` of their own never lands on their own through a door
 * that was meant for the other.
 */

/** What a door needs of a dataset: the name its reader types. */
export interface Addressed {
  qualifiedName: string;
}

const address = (t: Addressed) => encodeURIComponent(t.qualifiedName);

/** The dataset's page. */
export function datasetPageHref(t: Addressed): string {
  return `/tables/${address(t)}`;
}

/** The dataset's page with the set-geometry panel open. */
export function datasetGeometryHref(t: Addressed): string {
  return `${datasetPageHref(t)}?geometry=set`;
}

/** The SQL console, opened on the dataset. */
export function datasetQueryHref(t: Addressed): string {
  return `/sql?table=${address(t)}`;
}

/** The dataset's export in one format. */
export function datasetExportHref(t: Addressed, format: string): string {
  return `/api/tables/${address(t)}/export?format=${format}`;
}

/** The dataset a console door names, among the listed ones: the one whose
 * typed name it carries, so a door to someone else's `roads` never opens
 * one's own. */
export function doorTable<T extends Addressed>(tables: readonly T[], door: string | null): T | null {
  if (!door) return null;
  return tables.find((t) => t.qualifiedName === door) ?? null;
}
