import type { RunMember, WorkflowRun } from "./run-overlay";

/**
 * The Messages log: one entry per event of every listed run, composed
 * from the run records and the same for every reader — a run started, a
 * member started, a member that wrote its dataset, failed, was cancelled
 * or was not run, the run's outcome — newest first, each with its time,
 * its level and its words. A member that ended without an attempt carries
 * the run's finishing time. Entries of one time stand in a fixed order:
 * the run's outcome, then the members' outcomes in member order, then the
 * members' starts, then the run's start. Pure.
 */

export type Level = "info" | "ok" | "warn" | "error";

export interface LogEntry {
  runner?: WorkflowRun["runner"];
  id: string;
  runId: string;
  /** The node the entry is about; null for the run's own entries. */
  stepId: string | null;
  /** The node's name from the member's identity, kept after removal. */
  node: string | null;
  time: string;
  level: Level;
  text: string;
}

const nodes = (n: number) => `${n} node${n === 1 ? "" : "s"}`;

function nameOf(m: RunMember): string {
  return m.name ?? m.operation ?? m.stepId;
}

function runStartText(run: WorkflowRun): string {
  const n = run.members.length;
  if (run.kind === "run_all") return `Run all · ${nodes(n)}`;
  if (run.kind === "single") return `Run ${run.members[0] ? nameOf(run.members[0]) : "node"}`;
  return `Run from ${run.members[0] ? nameOf(run.members[0]) : "node"} · ${nodes(n)}`;
}

export function outcomeText(run: WorkflowRun): string {
  const total = run.members.length;
  const ok = run.members.filter((m) => m.state === "succeeded").length;
  switch (run.outcome) {
    case "completed":
      return "Completed";
    case "partly_completed":
      return `Partly completed · ${ok} of ${total} succeeded`;
    case "cancelled":
      return `Cancelled · ${ok} of ${total} succeeded`;
    case "failed":
      return "Failed";
    case "interrupted":
      return "Interrupted";
    default:
      return "";
  }
}

function memberOutcome(m: RunMember, run: WorkflowRun): { level: Level; text: string; time: string } | null {
  const name = nameOf(m);
  const endTime = m.attempt?.finishedAt ?? run.finishedAt ?? null;
  switch (m.state) {
    case "succeeded":
      return { level: "ok", text: `${name} wrote ${m.output?.name ?? m.attempt?.output?.name ?? name}`, time: endTime ?? run.startedAt };
    case "failed":
      if (m.attempt?.state === "cancelled" || (m.stoppedBy === "cancelled" && !m.attempt?.error)) {
        return { level: "warn", text: `${name} cancelled.`, time: endTime ?? run.startedAt };
      }
      return {
        level: "error",
        text: `${name} failed. ${m.attempt?.error?.message ?? m.stoppedReason ?? "The run failed."}`,
        // Refused at admission there is no attempt: the run's finishing time.
        time: m.attempt?.finishedAt ?? run.finishedAt ?? run.startedAt,
      };
    case "not_run": {
      const why =
        m.stoppedBy === "cancelled"
          ? "The run was cancelled before its turn."
          : m.stoppedBy === "operation_interrupted"
            ? "The server stopped before its turn."
            : m.stoppedReason
              ? m.stoppedReason
              : m.stoppedBy
                ? `${run.members.find((x) => x.stepId === m.stoppedBy) ? nameOf(run.members.find((x) => x.stepId === m.stoppedBy)!) : "A node it depends on"} did not succeed.`
                : "A node it depends on did not succeed.";
      return { level: "warn", text: `${name} not run. ${why}`, time: run.finishedAt ?? run.startedAt };
    }
    default:
      return null;
  }
}

/** The log for these runs, newest first, in the spec's order at one time. */
export function composeLog(runs: WorkflowRun[]): LogEntry[] {
  const out: (LogEntry & { rank: number; ord: number })[] = [];
  for (const run of runs) {
    // rank: the order at one time — the run's outcome (0), member outcomes
    // (1, by member order), member starts (2), the run's start (3).
    if (run.outcome && run.finishedAt) {
      out.push({ id: `${run.id}:outcome`, runId: run.id, stepId: null, node: null, time: run.finishedAt, level: run.outcome === "completed" ? "ok" : run.outcome === "failed" ? "error" : "warn", text: outcomeText(run), rank: 0, ord: 0 });
    }
    run.members.forEach((m, i) => {
      const o = memberOutcome(m, run);
      if (o) out.push({ id: `${run.id}:${m.stepId}:outcome`, runId: run.id, stepId: m.stepId, node: nameOf(m), time: o.time, level: o.level, text: o.text, rank: 1, ord: i });
      if (m.attempt?.startedAt) {
        out.push({ id: `${run.id}:${m.stepId}:start`, runId: run.id, stepId: m.stepId, node: nameOf(m), time: m.attempt.startedAt, level: "info", text: `${nameOf(m)} started`, rank: 2, ord: i });
      }
    });
    out.push({ id: `${run.id}:start`, runId: run.id, stepId: null, node: null, time: run.startedAt, level: "info", text: runStartText(run), rank: 3, ord: 0 });
  }
  out.sort((a, b) => {
    if (a.time !== b.time) return a.time < b.time ? 1 : -1;
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.ord - b.ord;
  });
  const actors = new Map(runs.map(run => [run.id, run.runner ?? null]));
  return out.map((e) => ({ runner: actors.get(e.runId), id: e.id, runId: e.runId, stepId: e.stepId, node: e.node, time: e.time, level: e.level, text: e.text }));
}

/** The entries about one node. */
export function forNode(entries: LogEntry[], stepId: string): LogEntry[] {
  return entries.filter((e) => e.stepId === stepId);
}
