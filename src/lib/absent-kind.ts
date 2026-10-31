/** What the gate tells the workspace's not-found page about an address it
 * served as finding nothing: which kind of item the person was after. */
export const ABSENT_KIND_HEADER = "x-dezfil-absent-kind";

const KIND_BY_FOLDER = {
  maps: "map",
  workflows: "workflow",
  tables: "dataset",
  projects: "project",
  templates: "template",
} as const;

export type AbsentKind = (typeof KIND_BY_FOLDER)[keyof typeof KIND_BY_FOLDER];

export const absentKindOfFolder = (folder: string): AbsentKind | null =>
  (KIND_BY_FOLDER as Record<string, AbsentKind>)[folder] ?? null;

/** The kind a request names, or none. A value set by hand changes only that
 * person's own wording on a page that already found nothing. */
export const readAbsentKind = (value: string | null): AbsentKind | null =>
  (Object.values(KIND_BY_FOLDER) as string[]).includes(value ?? "") ? (value as AbsentKind) : null;
