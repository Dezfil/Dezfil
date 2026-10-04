import type { AccountActor } from "@/lib/account-actor";
import type { RecipeOrigin } from "@/lib/metadata/recipes";
import type { RecipeSummary, WorkflowStatus } from "@/lib/operations/recipe-summary";

/**
 * What the workflows list reads and how it words it.
 *
 * The facts — origin, present reads, the summary — come from the recipe API;
 * this module only maps them to chips, filters and sorts, so the page invents
 * no classification of its own.
 */

/** A stale cause as the API reports it (the table, and its producer when
 * one of this workflow's nodes makes it). */
export interface StaleCause {
  reason: string;
  tableId: string;
  tableName: string;
  producedByStepId?: string;
}

/** A missing input as the API reports it; `throughStepId` when the node is
 * broken because a producer upstream is. */
export interface MissingInput {
  tableId: string;
  tableName: string;
  throughStepId?: string;
}

export interface LatestAttempt {
  state: string;
  startedAt?: string;
  finishedAt?: string;
  warnings?: string[];
  error?: { code: string; message: string };
}

/** A step as the recipe read publishes it:
 * the fields the workflow surfaces read, typed as the server sends them.
 * Nothing here is derived on the client. */
export interface WorkflowStep {
  id: string;
  ordinal: number;
  operation: string;
  parameters: Record<string, unknown>;
  /** The server's one-sentence account of the active definition. */
  summary?: string;
  /** A pending edit awaiting a successful run; null when there is none. */
  proposedParameters: Record<string, unknown> | null;
  output: { id: string; name: string | null } | null;
  /** The first condition — what a one-word surface would show. */
  condition: string;
  /** Every condition true of the step, in the API's precedence. */
  conditions: string[];
  /** Why it is stale, when it is; empty otherwise. */
  causes: StaleCause[];
  /** What it lost, when it is broken; empty otherwise. */
  missingInputs: MissingInput[];
  /** The recorded lineage of the last successful run. */
  inputs: { id: string; name: string }[];
  /** What it would read on its next run. */
  reads: string[];
  latestAttempt: LatestAttempt | null;
  lastSuccessAt: string | null;
}

export type ChipTone = "ok" | "warn" | "bad" | "muted" | "accent";

/** One node's state word on the workflow page, in the API's precedence:
 * un-runnable before un-current, a run in flight first of all. */
export function nodeState(step: WorkflowStep): { label: string; tone: ChipTone } {
  const attempt = step.latestAttempt?.state ?? null;
  if (attempt === "running") return { label: "running", tone: "accent" };
  if (attempt === "queued") return { label: "queued", tone: "muted" };
  const conditions = step.conditions;
  if (conditions.includes("broken")) return { label: "cannot run", tone: "bad" };
  if (attempt === "failed") return { label: "run failed", tone: "bad" };
  if (conditions.includes("output_missing")) return { label: "output deleted", tone: "warn" };
  if (conditions.includes("output_unavailable")) return { label: "output not available", tone: "muted" };
  if (conditions.includes("stale")) return { label: "stale", tone: "warn" };
  if (step.proposedParameters) return { label: "edited", tone: "warn" };
  if (conditions.includes("never_run")) return { label: "never run", tone: "muted" };
  return { label: "up to date", tone: "ok" };
}

export interface WorkflowListing {
  lastChangedAt?: string | null;
  lastChangedBy?: AccountActor | null;
  editRevision?: string;
  id: string;
  name: string;
  origin: RecipeOrigin;
  /** The project this workflow is in; null = not in one. */
  projectId: string | null;
  /** Its owner, and the SQL name of its SQL home. */
  owner?: { name: string; sqlName: string };
  home?: string;
  createdAt: string;
  updatedAt: string;
  summary: RecipeSummary;
  steps: WorkflowStep[];
}

export type WorkflowsFilter = "all" | "attention" | "never";
export type WorkflowsSort = "edited" | "created" | "name";
export const WORKFLOW_SORTS = ["edited", "created", "name"] as const;

/** The one chip a card wears, worded from the API's status. */
export function chipFor(summary: RecipeSummary): { label: string; tone: ChipTone } {
  const n = summary.count;
  const table: Record<WorkflowStatus, { label: string; tone: ChipTone }> = {
    empty: { label: "Empty", tone: "muted" },
    cannot_run: { label: `${n} cannot run`, tone: "bad" },
    in_progress: { label: `${n} in progress`, tone: "accent" },
    failed: { label: `${n} failed`, tone: "bad" },
    run_again: { label: `${n} to run again`, tone: "warn" },
    never_run: { label: "Never run", tone: "muted" },
    partly_never_run: { label: `${n} never run`, tone: "muted" },
    up_to_date: { label: "Up to date", tone: "ok" },
  };
  return table[summary.status];
}

/** *Needs attention* keeps cannot-run, failed and to-run-again; *Never run*
 * keeps non-empty workflows in which no node has produced an output. */
export function passesFilter(w: WorkflowListing, filter: WorkflowsFilter): boolean {
  const s = w.summary.status;
  if (filter === "attention") return s === "cannot_run" || s === "failed" || s === "run_again";
  if (filter === "never") return s === "never_run";
  return true;
}

export function matchesQuery(w: WorkflowListing, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || w.name.toLowerCase().includes(q);
}

export function sortWorkflows(list: WorkflowListing[], sort: WorkflowsSort): WorkflowListing[] {
  const out = [...list];
  if (sort === "name") out.sort((a, b) => a.name.localeCompare(b.name));
  else if (sort === "created") out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  else out.sort((a, b) => (b.lastChangedAt ?? "").localeCompare(a.lastChangedAt ?? ""));
  return out;
}

export const nodeWord = (n: number) => (n === 1 ? "node" : "nodes");
export const sourceWord = (n: number) => (n === 1 ? "source" : "sources");
export const datasetWord = (n: number) => (n === 1 ? "dataset" : "datasets");
