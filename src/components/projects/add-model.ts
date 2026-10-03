import type { ProjectScope } from "../scope/model";
import type { PersonLabel } from "../sharing/people";

/**
 * The 14-A dialog's pure model: the selection of datasets and the
 * workflows that make them, each by identity and each on its own, the live
 * footer's status and action label, the picker's search with the picked
 * row kept, and the ruled Enter resolution. Only one's own datasets and
 * workflows can be filed: another person's dependency is listed as not
 * one's to add and is never sent. The dialog only presents.
 */

export interface DependencyWire {
  id: string;
  name: string;
  /** The name its reader would type: `<sql name>.<name>` for someone
   * else's dataset. */
  qualifiedName?: string;
  owner?: PersonLabel;
  /** Whether the reader owns it, and so may file it. */
  owned?: boolean;
  source: string;
  rowCount: number;
  projectIds: string[];
  /** The dataset's spatial identity, for the tile. */
  geometryColumn: string | null;
  geometryType: string | null;
  producer: { id: string; name: string; owned?: boolean; editRevision?: string } | null;
}

/** Whether the reader may file this dependency: their own. */
export const addable = (d: { owned?: boolean }): boolean => d.owned !== false;

/** What is picked to come along: datasets and the workflows that make
 * them, each by identity. */
export interface FilingSelection {
  datasets: ReadonlySet<string>;
  workflows: ReadonlySet<string>;
}

/** A workflow that makes one of the subject's datasets. */
export interface ProducerRow {
  id: string;
  name: string;
  owned: boolean;
  editRevision?: string;
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
      editRevision?: string;
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

/** The workflows that make the subject's datasets, once each and in the
 * datasets' order, the subject itself aside (a workflow's own results). */
export function producersOf(subject: FilingSubject, deps: DependencyWire[]): ProducerRow[] {
  const seen = new Map<string, ProducerRow>();
  for (const d of deps) {
    const p = d.producer;
    if (!p || p.id === subject.id || seen.has(p.id)) continue;
    seen.set(p.id, { ...p, owned: p.owned !== false });
  }
  return [...seen.values()];
}

/** What starts selected: every dataset of one's own, and for a map the
 * workflows of one's own that make them (they came along before they
 * could be picked apart); a workflow's producers start unpicked, as they
 * never came along. */
export function initialSelection(subject: FilingSubject, deps: DependencyWire[]): FilingSelection {
  return {
    datasets: new Set(deps.filter(addable).map((d) => d.id)),
    workflows: new Set(
      subject.kind === "map" ? producersOf(subject, deps).filter((p) => p.owned).map((p) => p.id) : [],
    ),
  };
}

/** What is picked that may be filed: one's own datasets and workflows,
 * whatever else a selection holds. */
function picked(subject: FilingSubject, deps: DependencyWire[], selection: FilingSelection) {
  return {
    datasets: deps.filter((d) => addable(d) && selection.datasets.has(d.id)).map((d) => d.id),
    workflows: producersOf(subject, deps)
      .filter((p) => p.owned && selection.workflows.has(p.id))
      .map((p) => p.id),
  };
}

/** The membership change per kind: a map or a workflow moves with the
 * datasets and the producing workflows picked, each on its own; a
 * dataset is added alone. Nothing unpicked is filed, and nothing that is
 * not one's own. */
export function membersFor(
  subject: FilingSubject,
  deps: DependencyWire[],
  selection: FilingSelection,
): { addMaps?: string[]; addRecipes?: string[]; addTables?: string[] } {
  const chosen = picked(subject, deps, selection);
  if (subject.kind === "map") {
    return { addMaps: [subject.id], addTables: chosen.datasets, addRecipes: chosen.workflows };
  }
  if (subject.kind === "workflow") {
    return { addRecipes: [subject.id, ...chosen.workflows], addTables: chosen.datasets };
  }
  return { addTables: [subject.id] };
}

/** The distinct producers of the checked outputs — one workflow rides
 * once however many of its outputs are checked. */
export function distinctProducers(
  deps: DependencyWire[],
  checked: ReadonlySet<string>,
): NonNullable<DependencyWire["producer"]>[] {
  const seen = new Map<string, NonNullable<DependencyWire["producer"]>>();
  for (const d of deps) {
    if (checked.has(d.id) && d.producer) seen.set(d.producer.id, d.producer);
  }
  return [...seen.values()];
}

const word = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function footer(
  deps: DependencyWire[],
  selection: FilingSelection,
  destination: Destination,
  destinationName: (id: string) => string | null,
  kind: SubjectKind = "map",
): { status: string; label: string; enabled: boolean } {
  // Counted as filed: what is picked and one's own. A dataset is alone.
  const chosen =
    kind === "dataset"
      ? { datasets: [], workflows: [] }
      : picked({ kind, id: "", name: "", projectId: null }, deps, selection);
  const datasets = chosen.datasets.length;
  const workflows = chosen.workflows.length;
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
