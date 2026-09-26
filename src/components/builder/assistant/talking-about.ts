/**
 * The "talking about" chip row: one chip per subject, built from the
 * page's loaded display facts for the same identities and the same
 * execution or run snapshot the next message carries. No product read
 * of its own: the page hands in what it already shows (names, labels,
 * the edited mark, outcomes and times) and this rule words the chips.
 * They change with the page's state without a message and are never
 * controls. Pure.
 */

export type ChipIcon = "map" | "layer" | "draft" | "result" | "warn" | "flow" | "node" | "run";

export interface TalkingChip {
  key: string;
  /** The subject's word, quiet. */
  label: string;
  /** The fact, in the page's own words. */
  value: string;
  icon: ChipIcon;
  /** The failure tone, for a failed execution or run. */
  tone?: "bad";
  /** The value is an identifier, set in the mono face. */
  mono?: boolean;
}

export type SqlExecutionFact =
  | null
  | { kind: "result"; rows: number; elapsedMs: number }
  | { kind: "error"; message: string };

export type WorkflowRunFact =
  | null
  | { kind: "running"; startedAt: string }
  | { kind: "settled"; outcome: string; finishedAt: string };

export type PageFacts =
  | { page: "builder"; mapName: string; selectedLayerName: string | null }
  | { page: "sql"; draft: string; edited: boolean; execution: SqlExecutionFact }
  | { page: "workflow"; workflowName: string; selectedStepLabel: string | null; run: WorkflowRunFact };

const rows = new Intl.NumberFormat("en-US");

/** A count of the draft's lines as the page counts them: an empty draft
 * has none, a trailing newline adds no line. */
export function draftLines(draft: string): number {
  if (draft.trim() === "") return 0;
  const body = draft.endsWith("\n") ? draft.slice(0, -1) : draft;
  return body.split("\n").length;
}

/** Seconds with one decimal under a minute; whole seconds above. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) return `${(Math.round(seconds * 10) / 10).toFixed(1)} s`;
  return `${Math.round(seconds)} s`;
}

/** The age of a moment in the page's words: just now, then minutes,
 * hours, days. */
export function formatAge(at: string, now: number): string {
  const then = Date.parse(at);
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} d ago`;
}

/** The run's outcome as the results band words it. */
export function outcomeWord(outcome: string): string {
  switch (outcome) {
    case "completed": return "completed";
    case "partly_completed": return "partly completed";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    case "interrupted": return "interrupted";
    default: return outcome;
  }
}

export function talkingAbout(facts: PageFacts, now: number = Date.now()): TalkingChip[] {
  if (facts.page === "builder") {
    const chips: TalkingChip[] = [{ key: "map", label: "Map", value: facts.mapName, icon: "map" }];
    if (facts.selectedLayerName !== null) chips.push({ key: "layer", label: "Layer", value: facts.selectedLayerName, icon: "layer", mono: true });
    return chips;
  }
  if (facts.page === "sql") {
    const lines = draftLines(facts.draft);
    const draft = lines === 0 ? "empty" : `${lines} ${lines === 1 ? "line" : "lines"}${facts.edited ? ", edited" : ""}`;
    const chips: TalkingChip[] = [{ key: "draft", label: "Draft", value: draft, icon: "draft" }];
    if (facts.execution?.kind === "result") {
      chips.push({ key: "execution", label: "Last result", value: `${rows.format(facts.execution.rows)} ${facts.execution.rows === 1 ? "row" : "rows"} · ${formatElapsed(facts.execution.elapsedMs)}`, icon: "result" });
    } else if (facts.execution?.kind === "error") {
      chips.push({ key: "execution", label: "Last run", value: `Error: ${facts.execution.message}`, icon: "warn", tone: "bad" });
    }
    return chips;
  }
  const chips: TalkingChip[] = [{ key: "workflow", label: "Workflow", value: facts.workflowName, icon: "flow" }];
  if (facts.selectedStepLabel !== null) chips.push({ key: "step", label: "Node", value: facts.selectedStepLabel, icon: "node" });
  if (facts.run?.kind === "running") {
    chips.push({ key: "run", label: "Last run", value: "in progress", icon: "run" });
  } else if (facts.run?.kind === "settled") {
    const bad = facts.run.outcome === "failed";
    chips.push({ key: "run", label: "Last run", value: `${outcomeWord(facts.run.outcome)}, ${formatAge(facts.run.finishedAt, now)}`, icon: bad ? "warn" : "run", ...(bad ? { tone: "bad" as const } : {}) });
  }
  return chips;
}
