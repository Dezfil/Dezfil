import { bindDeletionInputs } from "@/lib/auth/account-deletion-work";
import { registerQueryStore } from "@/lib/query/retained";
import { AsyncLocalStorage } from "node:async_hooks";
import type { DuckDBConnection } from "@duckdb/node-api";
import { classifyReference } from "./reference-forms";
import { mountPlanOf, type MountPlan } from "./mount-plan";

/**
 * What an evaluation drew: the dataset identities its SQL bound, each with
 * the artifact it was read from, as the evaluation's own registration
 * mounted them. The compiler notes every table reference it binds on the
 * evaluation's connection (static, dynamic and nested), so the evidence is
 * the evaluation's own, never a later resolution of the same text.
 *
 * An evaluation that read the engine's catalogue (its catalogue functions,
 * the information schema, a listing of relations) could have seen every
 * dataset it had mounted, so its evidence is conservatively that whole
 * namespace, the caller's whole reach in the evaluation's home.
 *
 * A retained artifact (a tile archive, a card image, a published view held
 * for its freshness bound) keeps this evidence and is served only to a
 * caller who can now reach every dataset in it.
 */
export interface ArtifactInput {
  id: string;
  file: string;
}
export interface ArtifactInputs {
  datasets: readonly ArtifactInput[];
  /** True when the evidence is the evaluation's whole namespace because it
   * read the engine's catalogue. */
  catalogue: boolean;
}

export const NO_INPUTS: ArtifactInputs = Object.freeze({ datasets: Object.freeze([]) as readonly ArtifactInput[], catalogue: false });

interface Recorder {
  ids: Set<string>;
  catalogue: boolean;
}

/** Notes belong to the connection that compiled them, and nothing else. */
let recorders = new WeakMap<DuckDBConnection, Recorder>();

function recorder(conn: DuckDBConnection): Recorder {
  let found = recorders.get(conn);
  if (!found) {
    found = { ids: new Set(), catalogue: false };
    recorders.set(conn, found);
  }
  return found;
}

/** The evaluation read the engine's catalogue: its evidence is everything it
 * had mounted. */
export function noteCatalogue(conn: DuckDBConnection): void {
  bindDeletionInputs(mountPlanOf(conn)?.namespace.datasets.map(dataset => dataset.ownerId) ?? []);
  recorder(conn).catalogue = true;
}

/**
 * One table reference the compiler met outside a common table expression,
 * as written. A dataset the plan binds is noted by identity; a reserved
 * output or a qualified name outside reach binds nothing and fails on its
 * own; any other name is one of the engine's own relations (or a name the
 * engine refuses), which is read as the catalogue.
 */
export function noteReference(conn: DuckDBConnection, plan: MountPlan | undefined, parts: readonly string[]): void {
  if (!plan) return;
  const classified = classifyReference(parts);
  if (classified.form === "engine") {
    noteCatalogue(conn);
    return;
  }
  let view: string | null | undefined;
  if (classified.form === "plain") {
    view = plan.plain.get(classified.name);
    if (view === undefined) {
      noteCatalogue(conn);
      return;
    }
  } else {
    const binding = plan.qualified.get(`${classified.qualifier}.${classified.name}`);
    if (!binding) return;
    if ("synthetic" in binding) {
      bindDeletionInputs([binding.synthetic.ownerId]);
      recorder(conn).ids.add(binding.synthetic.id);
      return;
    }
    view = binding.view;
  }
  if (view === null) return;
  const mount = plan.views.get(view.toLowerCase());
  if (mount) { bindDeletionInputs([mount.dataset.ownerId]); recorder(conn).ids.add(mount.dataset.id); }
}

function normalized(entries: Iterable<ArtifactInput>, catalogue: boolean): ArtifactInputs {
  const byId = new Map<string, ArtifactInput>();
  for (const entry of entries) byId.set(entry.id, { id: entry.id, file: entry.file });
  const datasets = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { datasets, catalogue };
}

/** The evidence one connection's evaluation recorded, from its own mounts. */
export function recordedInputs(conn: DuckDBConnection): ArtifactInputs {
  const plan = mountPlanOf(conn);
  const notes = recorders.get(conn);
  if (!plan || !notes) return NO_INPUTS;
  const drawn = notes.catalogue
    ? plan.namespace.datasets
    : plan.namespace.datasets.filter((dataset) => notes.ids.has(dataset.id));
  return normalized(drawn.map((dataset) => ({ id: dataset.id, file: dataset.file })), notes.catalogue);
}

/** Two pieces of evidence as one: everything either drew. */
export function mergeInputs(left: ArtifactInputs, right: ArtifactInputs): ArtifactInputs {
  return normalized([...left.datasets, ...right.datasets], left.catalogue || right.catalogue);
}

/** A stable text of the evidence: what a fingerprint folds in. */
export function inputsKey(inputs: ArtifactInputs): string {
  return JSON.stringify([inputs.catalogue, inputs.datasets.map((input) => [input.id, input.file])]);
}

/** Evidence read back from storage, or null when it is not evidence. */
export function parseInputs(value: unknown): ArtifactInputs | null {
  if (!value || typeof value !== "object") return null;
  const { datasets, catalogue } = value as { datasets?: unknown; catalogue?: unknown };
  if (typeof catalogue !== "boolean" || !Array.isArray(datasets)) return null;
  const entries: ArtifactInput[] = [];
  for (const entry of datasets) {
    if (!entry || typeof entry !== "object") return null;
    const { id, file } = entry as { id?: unknown; file?: unknown };
    if (typeof id !== "string" || typeof file !== "string") return null;
    entries.push({ id, file });
  }
  return normalized(entries, catalogue);
}

/**
 * Artifacts made of several evaluations (a published view assembles every
 * layer and widget) collect the evidence of each one that settles while the
 * work runs. The boundary folds each evaluation in, failed ones included,
 * into every collection open where it was started.
 */
interface Collection {
  entries: Map<string, ArtifactInput>;
  catalogue: boolean;
}
const collecting = new AsyncLocalStorage<readonly Collection[]>();
const collections = new Set<Promise<unknown>>();

export async function collectInputs<T>(work: () => Promise<T>): Promise<{ value: T; inputs: ArtifactInputs }> {
  const mine: Collection = { entries: new Map(), catalogue: false };
  const pending = collecting.run([...(collecting.getStore() ?? []), mine], work);
  collections.add(pending);
  try { return { value: await pending, inputs: normalized(mine.entries.values(), mine.catalogue) }; }
  finally { collections.delete(pending); mine.entries.clear(); }
}

/** The collections open where an evaluation starts. */
export function openCollections(): readonly Collection[] | undefined {
  return collecting.getStore();
}

/** Fold one settled evaluation's evidence into the collections it ran under. */
export function foldEvaluation(collections: readonly Collection[] | undefined, conn: DuckDBConnection): void {
  if (!collections?.length) return;
  const inputs = recordedInputs(conn);
  for (const collection of collections) {
    for (const input of inputs.datasets) collection.entries.set(input.id, input);
    collection.catalogue ||= inputs.catalogue;
  }
}

registerQueryStore({ drain: async () => {}, busy: () => false, clear: () => { recorders = new WeakMap<DuckDBConnection, Recorder>(); } });
export function inputRecorderForTests(conn: DuckDBConnection): boolean { return recorders.has(conn); }

registerQueryStore({ drain: async () => { await Promise.allSettled([...collections]); }, busy: () => collections.size > 0, clear: () => collecting.disable() });
export function inputCollectionsForTests(): number { return collections.size; }
