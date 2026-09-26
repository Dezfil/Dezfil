import type { ChipTone } from "../workflow-model";

/**
 * The run in flight, as the tiles wear it: the record's word for each
 * member — waiting until admitted, queued while its attempt waits in
 * the lane, running, then the settled word — with the reason in the
 * API's words for a failed, cancelled or not-run member. Pure: what the
 * run record says, nothing anticipated.
 */

export type RunMemberState = "pending" | "running" | "succeeded" | "failed" | "not_run";
export type AttemptState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface RunAttempt {
  state: AttemptState;
  error: { code: string; message: string } | null;
  acceptedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  output: { id: string; name: string } | null;
}

export interface RunMember {
  stepId: string;
  ordinal: number;
  operation: string | null;
  name: string | null;
  state: RunMemberState;
  jobId: string | null;
  stoppedBy: string | null;
  stoppedReason: string | null;
  output: { id: string; name: string } | null;
  attempt: RunAttempt | null;
}

export type RunOutcome = "completed" | "partly_completed" | "failed" | "cancelled" | "interrupted";

export interface WorkflowRun {
  id: string;
  recipeId: string;
  kind: "run_all" | "from_step" | "single";
  outcome: RunOutcome | null;
  cancelled: boolean;
  startedAt: string;
  finishedAt: string | null;
  members: RunMember[];
  outputs?: { id: string; name: string }[];
}

export type RunWord = "waiting" | "queued" | "running" | "up to date" | "run failed" | "cancelled" | "not run";

export interface RunMemberOverlay {
  word: RunWord;
  tone: ChipTone;
  /** The API's reason for a failed, cancelled or not-run member. */
  reason: string | null;
}

export interface RunOverlay {
  runId: string;
  members: Record<string, RunMemberOverlay>;
}

/** The word a member wears from its record and its attempt. */
export function memberWord(m: RunMember, run?: WorkflowRun): RunMemberOverlay {
  const a = m.attempt;
  switch (m.state) {
    case "pending":
      return { word: "waiting", tone: "muted", reason: null };
    case "running":
      return a?.state === "queued"
        ? { word: "queued", tone: "muted", reason: null }
        : { word: "running", tone: "accent", reason: null };
    case "succeeded":
      return { word: "up to date", tone: "ok", reason: null };
    case "failed":
      if (a?.state === "cancelled" || m.stoppedBy === "cancelled") {
        return { word: "cancelled", tone: "warn", reason: "Cancelled while running." };
      }
      return { word: "run failed", tone: "bad", reason: a?.error?.message ?? m.stoppedReason ?? "The run failed." };
    case "not_run":
      return { word: "not run", tone: "warn", reason: notRunReason(m, run) };
  }
}

function notRunReason(m: RunMember, run?: WorkflowRun): string {
  if (m.stoppedBy === "cancelled") return "Not run: the run was cancelled before its turn.";
  if (m.stoppedBy === "operation_interrupted") return "Not run: the server stopped before its turn.";
  if (m.stoppedReason) return `Not run. ${m.stoppedReason}`;
  const blocker = run ? stoppedByName(run, m) : null;
  return blocker ? `Not run: ${blocker} did not succeed.` : "Not run: a node it depends on did not succeed.";
}

/** The overlay for a run being shown; null when there is none. */
export function overlayFor(run: WorkflowRun | null): RunOverlay | null {
  if (!run) return null;
  const members: Record<string, RunMemberOverlay> = {};
  for (const m of run.members) members[m.stepId] = memberWord(m, run);
  return { runId: run.id, members };
}

/** Which member reads what stopped a not-run member, by name. */
export function stoppedByName(run: WorkflowRun, m: RunMember): string | null {
  if (!m.stoppedBy) return null;
  const blocker = run.members.find((x) => x.stepId === m.stoppedBy);
  return blocker ? (blocker.name ?? blocker.operation ?? blocker.stepId) : null;
}

/** The outcome line's words. */
export function outcomeLine(run: WorkflowRun): string {
  const total = run.members.length;
  const ok = run.members.filter((m) => m.state === "succeeded").length;
  const nodes = (n: number) => `${n} node${n === 1 ? "" : "s"}`;
  switch (run.outcome) {
    case "completed":
      return `Completed · ${nodes(total)}`;
    case "partly_completed":
      return `Partly completed · ${ok} of ${total} succeeded`;
    case "failed":
      return `Failed · ${ok} of ${total} succeeded`;
    case "cancelled":
      return `Cancelled · ${ok} of ${total} succeeded`;
    case "interrupted":
      return `Interrupted · ${ok} of ${total} succeeded`;
    default:
      return "";
  }
}

/** How many members have settled, for the dock's N of M. */
export function settledCount(run: WorkflowRun): number {
  return run.members.filter((m) => m.state !== "pending" && m.state !== "running").length;
}

/** The newest hundred with this run's answer merged in (the coordinator's live list). */
export function mergeRun(list: WorkflowRun[], run: WorkflowRun): WorkflowRun[] {
  const i = list.findIndex((r) => r.id === run.id);
  if (i === -1) return [run, ...list].slice(0, 100);
  const next = list.slice();
  next[i] = run;
  return next;
}
