import type { OperationDef } from "@/lib/operations/catalog";
import { formatCount, type TableListing } from "../api";
import type { WorkflowStep } from "../workflow-model";
import { readKey } from "../workflow-producers";
import { listedFor, type CanvasGraph, type CanvasMember, type NodeMember } from "./graph";
import { heldTableIds, writtenInHome } from "./home-names";
import { classOfTable, classRefusal, expectedClass, linkRefusal, memberByName, outputNameOf, type GeometryClass } from "./link-rules";

/**
 * The node panel's arithmetic, kept out of the component so each decision
 * is a table test rather than a rendering check: which callouts a node
 * wears and in what order, which values a pending edit changes, and what
 * the input picker offers first and why it refuses the rest.
 */

export type CalloutTone = "bad" | "warn" | "plain";

export interface Callout {
  key: string;
  tone: CalloutTone;
  /** The lead, in bold. */
  head: string;
  /** The rest of the sentence, when there is one. */
  body?: string;
  /** A message the API reported verbatim, set in the mono face. */
  mono?: string;
  /** The changed values, for the *edited* callout. */
  changes?: ChangedValue[];
}

export interface ChangedValue {
  name: string;
  was: string;
  now: string;
}

/** A value as the panel says it: lists joined, aggregates as call syntax. */
export function showValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "not set";
  if (Array.isArray(value)) {
    if (value.length === 0) return "none";
    return value
      .map((x) =>
        typeof x === "object" && x !== null
          ? `${String((x as { aggregate?: unknown }).aggregate ?? "")}${
              (x as { field?: unknown; column?: unknown }).field ?? (x as { column?: unknown }).column
                ? `(${String((x as { field?: unknown }).field ?? (x as { column?: unknown }).column)})`
                : ""
            }`
          : String(x),
      )
      .join(", ");
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Every value a pending edit changes, old beside new. */
export function changedValues(step: WorkflowStep): ChangedValue[] {
  const proposed = step.proposedParameters;
  if (!proposed) return [];
  const keys = new Set([...Object.keys(step.parameters), ...Object.keys(proposed)]);
  const out: ChangedValue[] = [];
  for (const key of keys) {
    const was = step.parameters[key];
    const now = proposed[key];
    if (JSON.stringify(was ?? null) === JSON.stringify(now ?? null)) continue;
    out.push({ name: key.replace(/_/g, " "), was: showValue(was), now: showValue(now) });
  }
  return out;
}

function causeSentence(cause: { reason: string; tableName: string }): string {
  if (cause.reason === "source_changed") return `${cause.tableName} has new data since this ran.`;
  if (cause.reason === "upstream_re_ran") return `${cause.tableName} was written again after this ran.`;
  if (cause.reason === "upstream_stale") return `The node that writes ${cause.tableName} is itself stale.`;
  return `${cause.tableName}: ${cause.reason.replace(/_/g, " ")}.`;
}

/**
 * What the API reports about a node, disclosure order: a run in flight
 * first, then what stops it running, then what its last run did, then
 * what makes it un-current, then the pending edit.
 */
export function callouts(member: NodeMember, operation: OperationDef | null): Callout[] {
  const step = member.step;
  const out: Callout[] = [];
  const attempt = step.latestAttempt;
  const hasOutput = step.output !== null;
  // The run in flight speaks first: its word and its reason.
  if (member.run) {
    const r = member.run;
    const head =
      r.word === "waiting"
        ? "Waiting to run."
        : r.word === "queued"
          ? "Queued."
          : r.word === "running"
            ? "Running."
            : r.word === "not run"
              ? "Not run."
              : r.word === "cancelled"
                ? "Cancelled."
                : r.word === "run failed"
                  ? "The run failed."
                  : "Ran.";
    out.push({ key: `run:${r.word}`, tone: r.tone === "bad" ? "bad" : r.tone === "warn" ? "warn" : "plain", head, body: r.reason ?? undefined });
    if (r.word === "waiting" || r.word === "queued" || r.word === "running") return out;
  }
  if (attempt?.state === "running") out.push({ key: "running", tone: "plain", head: "Running." });
  else if (attempt?.state === "queued") out.push({ key: "queued", tone: "plain", head: "Queued.", body: "It runs when its turn comes." });
  if (step.conditions.includes("broken")) {
    const names = step.missingInputs.map((m) =>
      m.throughStepId ? `${m.tableName} comes from a node that cannot run` : `${m.tableName} no longer exists`,
    );
    out.push({ key: "broken", tone: "bad", head: "Cannot run.", body: names.length ? `${names.join("; ")}.` : undefined });
  }
  if (operation?.availability && !operation.availability.available) {
    out.push({ key: "unavailable", tone: "bad", head: "Unavailable on this instance.", body: operation.availability.reason ?? undefined });
  }
  if (attempt?.state === "failed") {
    out.push({
      key: "failed",
      tone: "bad",
      head: "The last run failed.",
      body: hasOutput ? "The previous output stands." : undefined,
      mono: attempt.error?.message,
    });
  }
  if (attempt?.state === "cancelled") {
    out.push({ key: "cancelled", tone: "warn", head: "The last run was cancelled.", body: hasOutput ? "The previous output stands." : undefined });
  }
  if (step.conditions.includes("output_missing")) {
    out.push({ key: "output_missing", tone: "warn", head: "Output deleted.", body: "The dataset this made is gone. Run again to make it." });
  }
  if (step.conditions.includes("stale")) {
    out.push({ key: "stale", tone: "warn", head: "Stale.", body: step.causes.map(causeSentence).join(" ") || undefined });
  }
  const changes = changedValues(step);
  if (step.proposedParameters) {
    out.push({
      key: "edited",
      tone: "warn",
      head: "Edited. Run to apply.",
      body: hasOutput ? "The output still holds the last run." : undefined,
      changes,
    });
  }
  if (attempt?.state === "succeeded" && attempt.warnings?.length) {
    out.push({ key: "warnings", tone: "plain", head: attempt.warnings.join(" ") });
  }
  return out;
}

export interface PickerOption {
  /** The value the input would hold: the output's or table's name; empty for an output not named yet. */
  name: string;
  /** What the row shows: the name, or the node's label for an unnamed output. */
  label: string;
  /** Whether the name is a node's output on this canvas. */
  node: boolean;
  /** Why the link is refused, for the ones that are. */
  reason: string | null;
  /** The geometry the row's glyph shows, as far as it is known before a run. */
  kind: GeometryClass;
  /** The row's fact: a table's row count, *node* for an output, *missing*, *not named*. */
  fact: string;
  /** The node's own id, for an output not named yet (two unnamed nodes share a label). */
  id?: string;
}

/**
 * What an input's picker offers (the rows' facts): the canvas's members
 * that the link rules accept first, then the ones they refuse with each
 * reason (a node whose output has no name yet among them, identified by
 * its label), then the workspace tables not on the canvas. A current
 * value none of the groups hold is the control's to show, marked not
 * accepted (`currentOption`).
 */
export function pickerOptions(args: {
  to: NodeMember;
  port: string;
  graph: CanvasGraph;
  operations: OperationDef[];
  tables: TableListing[];
}): { accepted: PickerOption[]; refused: PickerOption[]; elsewhere: PickerOption[] } {
  const { to, port, graph, operations, tables } = args;
  const accepted: PickerOption[] = [];
  const refused: PickerOption[] = [];
  const seen = new Set<string>();
  for (const m of graph.members) {
    if (m.id === to.id) continue;
    const name = outputNameOf(m as CanvasMember);
    const reason = linkRefusal({ from: m, to, port, graph, operations, tables });
    const kind = expectedClass(m as CanvasMember, graph, operations, tables);
    if (!name) {
      // An output not named yet: refused by the link rules, shown by its node.
      if (m.kind === "node") refused.push({ name: "", label: m.label, node: true, reason, kind, fact: "not named", id: m.id });
      continue;
    }
    const key = readKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    const fact = m.kind === "node" ? "node" : m.missing ? "missing" : m.table ? `${formatCount(m.table.rowCount)} rows` : "";
    (reason === null ? accepted : refused).push({ name, label: name, node: m.kind === "node", reason, kind, fact });
  }
  // A workspace table not on the canvas is offered under the same rules:
  // the class it holds against what the input accepts. It is offered by the
  // name the workflow's home writes it, so the reader's own dataset is never
  // stored as a same-named one of the home's; one the canvas already holds
  // is its member's row.
  const input = operations.find((o) => o.id === to.step.operation)?.inputs.find((i) => i.name === port) ?? null;
  const elsewhere: PickerOption[] = [];
  const held = heldTableIds(graph);
  for (const t of tables) {
    if (held.has(t.id)) continue;
    const name = writtenInHome(t, graph.home);
    const key = readKey(name);
    if (seen.has(key)) continue;
    if (memberByName(graph, name)) continue;
    seen.add(key);
    const kind = classOfTable(t);
    const reason = input ? classRefusal(input, name, kind) : null;
    (reason === null ? elsewhere : refused).push({ name, label: name, node: false, reason, kind, fact: `${formatCount(t.rowCount)} rows` });
  }
  const byName = (a: PickerOption, b: PickerOption) => a.label.localeCompare(b.label);
  return { accepted: accepted.sort(byName), refused: refused.sort(byName), elsewhere: elsewhere.sort(byName) };
}

/** The row for the input's current value: the group's own when one holds
 * it, else a refused row of its own, since a value can name a table that
 * is gone or an output that no longer fits. */
export function currentOption(
  current: string | null,
  options: { accepted: PickerOption[]; refused: PickerOption[]; elsewhere: PickerOption[] },
): PickerOption | null {
  if (!current) return null;
  const key = readKey(current);
  for (const list of [options.accepted, options.elsewhere, options.refused]) {
    const hit = list.find((o) => o.name !== "" && readKey(o.name) === key);
    if (hit) return hit;
  }
  return { name: current, label: current, node: false, reason: `“${current}” is not on the canvas or in the workspace.`, kind: "unknown", fact: "missing" };
}

/** The nodes downstream of a node, transitively, by the present reads:
 * what *Run from here* carries besides the node. */
export function downstreamOf(graph: CanvasGraph, id: string): NodeMember[] {
  const readers = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.time === "lineage") continue;
    const list = readers.get(e.from) ?? [];
    list.push(e.to);
    readers.set(e.from, list);
  }
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const next of readers.get(cur) ?? []) {
      if (seen.has(next) || next === id) continue;
      seen.add(next);
      stack.push(next);
    }
  }
  return graph.members.filter((m): m is NodeMember => m.kind === "node" && seen.has(m.id));
}

/** Whether a name an input holds is an output nothing has produced yet. A
 * listed dataset the name points at in the workflow's home says it is
 * there; the reader's own same-named dataset says nothing. */
export function unproducedOutput(name: string | null, graph: CanvasGraph, tables: TableListing[]): boolean {
  if (!name) return false;
  if (listedFor(tables, name, graph.home)) return false;
  const m = memberByName(graph, name);
  return m !== null && m.kind === "node" && m.step.output === null;
}
