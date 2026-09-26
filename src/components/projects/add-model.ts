import type { ProjectScope } from "../scope/model";

/**
 * The 14-A dialog's pure model: selection counting with producers
 * deduplicated by workflow identity, the live footer's status and
 * action label, the picker's search with the picked row kept, and the
 * ruled Enter resolution. The dialog only presents.
 */

export interface DependencyWire {
  id: string;
  name: string;
  source: string;
  rowCount: number;
  projectIds: string[];
  /** The dataset's spatial identity, for the tile. */
  geometryColumn: string | null;
  geometryType: string | null;
  producer: { id: string; name: string } | null;
}

export type Destination =
  { kind: "existing"; id: string } | { kind: "new"; name: string } | null;

/** What is being filed: a map or a workflow lives in
 * one project and moves; a dataset can be in several and is only ever
 * added. */
export type FilingSubject =
  | {
      kind: "map" | "workflow";
      id: string;
      name: string;
      projectId: string | null;
    }
  | { kind: "dataset"; id: string; name: string; projectIds: string[] };

export type SubjectKind = FilingSubject["kind"];

/** The copy per kind: the dialog presents, this decides the words. */
export function subjectCopy(kind: SubjectKind): {
  noun: string;
  /** The line under the title, or none: a hint names a surprise,
   * and only the dataset dialog has one — a dataset is added, never
   * moved. */
  subtitle: string | null;
  checklist: string | null;
  reading: string;
  empty: string;
} {
  if (kind === "workflow") {
    return {
      noun: "Workflow",
      subtitle: null,
      checklist: "Datasets it reads and writes",
      reading: "Reading the workflow's datasets…",
      empty: "This workflow reads and writes no registered datasets.",
    };
  }
  if (kind === "dataset") {
    return {
      noun: "Dataset",
      subtitle:
        "A dataset can be in several projects. It stays in the ones it is in.",
      checklist: null,
      reading: "Loading the projects…",
      empty: "",
    };
  }
  return {
    noun: "Map",
    subtitle: null,
    checklist: "Datasets it uses",
    reading: "Reading the map's datasets…",
    empty: "This map draws from no registered datasets.",
  };
}

/** The dialog's title in three parts, the subject's name apart from
 * the sentence around it so the head can set only the name in bold: a filed map or workflow moves; a dataset is always
 * added (never "moved" — it keeps its other memberships). */
export function dialogTitleParts(subject: FilingSubject): {
  before: string;
  name: string;
  after: string;
} {
  const moves = subject.kind !== "dataset" && subject.projectId !== null;
  return {
    before: moves ? "Move " : "Add ",
    name: subject.name,
    after: moves ? " to another project" : " to a project",
  };
}

/** The whole sentence: the dialog's accessible name. */
export function dialogTitle(subject: FilingSubject): string {
  const p = dialogTitleParts(subject);
  return `${p.before}${p.name}${p.after}`;
}

/** The membership change per kind (rules kept for the map):
 * a map moves with its checked datasets and their producers; a
 * workflow moves with only its checked datasets — never their
 * producers; a dataset is added alone. */
export function membersFor(
  subject: FilingSubject,
  deps: DependencyWire[],
  checked: ReadonlySet<string>,
): { addMaps?: string[]; addRecipes?: string[]; addTables?: string[] } {
  const datasetIds = deps.filter((d) => checked.has(d.id)).map((d) => d.id);
  if (subject.kind === "map") {
    return {
      addMaps: [subject.id],
      addTables: datasetIds,
      addRecipes: distinctProducers(deps, checked).map((p) => p.id),
    };
  }
  if (subject.kind === "workflow") {
    return { addRecipes: [subject.id], addTables: datasetIds };
  }
  return { addTables: [subject.id] };
}

/** The distinct producers of the checked outputs — one workflow rides
 * once however many of its outputs are checked. */
export function distinctProducers(
  deps: DependencyWire[],
  checked: ReadonlySet<string>,
): { id: string; name: string }[] {
  const seen = new Map<string, { id: string; name: string }>();
  for (const d of deps) {
    if (checked.has(d.id) && d.producer) seen.set(d.producer.id, d.producer);
  }
  return [...seen.values()];
}

const word = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function footer(
  deps: DependencyWire[],
  checked: ReadonlySet<string>,
  destination: Destination,
  destinationName: (id: string) => string | null,
  kind: SubjectKind = "map",
): { status: string; label: string; enabled: boolean } {
  const datasets = deps.filter((d) => checked.has(d.id)).length;
  // Producers ride along with a MAP's checked outputs; a workflow moves
  // with its datasets only, a dataset alone.
  const workflows =
    kind === "map" ? distinctProducers(deps, checked).length : 0;
  const total = 1 + datasets + workflows;
  const noun = subjectCopy(kind).noun;
  const status =
    kind === "dataset"
      ? noun
      : datasets
        ? `${noun} · ${word(datasets, "dataset")}${workflows ? ` · ${word(workflows, "workflow")}` : ""}`
        : `${noun} only`;
  let label = kind === "dataset" ? "Add" : `Add ${word(total, "item")}`;
  let enabled = false;
  if (destination?.kind === "new") {
    const name = destination.name.trim();
    label += name ? ` to ${name}` : " to a new project";
    // The full name contract gates confirmation: non-empty AND within
    // the bound, so the server cannot refuse a "valid" destination.
    enabled = name.length > 0 && name.length <= 120;
  } else if (destination?.kind === "existing") {
    const name = destinationName(destination.id);
    if (name) label += ` to ${name}`;
    enabled = true;
  }
  return { status, label, enabled };
}

/** The rows matching the search; the picked row stays visible whatever
 * is typed (the reference's rule). */
export function searchRows<T extends { id: string; name: string }>(
  projects: T[],
  query: string,
  pickedId: string | null,
): { shown: T[]; hits: T[] } {
  const q = query.trim().toLowerCase();
  const hits = q
    ? projects.filter((p) => p.name.toLowerCase().includes(q))
    : projects;
  const shown = projects.filter((p) => hits.includes(p) || p.id === pickedId);
  return { shown, hits };
}

/** Enter in the search: one selectable hit picks it; none starts New
 * with the typed text as the proposed name; several do nothing. */
export function resolveEnter(
  hits: { id: string }[],
  query: string,
  selectable: (id: string) => boolean,
): { kind: "pick"; id: string } | { kind: "new"; name: string } | null {
  const eligible = hits.filter((h) => selectable(h.id));
  if (eligible.length === 1) return { kind: "pick", id: eligible[0].id };
  if (hits.length === 0) return { kind: "new", name: query.trim() };
  return null;
}

/** The wording of the opening action: a filed map or workflow moves; a
 * dataset is always added. */
export function actionLabel(
  kind: SubjectKind | ProjectScope | null,
  filed: boolean,
): string {
  if (kind === "dataset") return "Add to a project";
  return filed ? "Move to another project" : "Add to a project";
}
