import type { Position } from "./arrange";
import type { Definition } from "./canvas-history";
import { normalName } from "../workflow-producers";

/**
 * The inverse decisions (the plan's resumable inverses): what a fresh
 * read of the recipe says has landed of an inverse, which identity a
 * restored node takes, what remains to do, and which refusals keep a
 * step for the next press against which drop it with the reason. Read
 * in, decision out; nothing is applied here, so a lost answer never
 * lands a stage twice. Pure.
 */

/** A node as the recipe read gives it, the facts the decisions need. */
export interface ReadStep {
  id: string;
  operation: string;
  ordinal: number;
  parameters: Record<string, unknown>;
  proposedParameters: Record<string, unknown> | null;
  output: { id: string; name: string | null } | null;
  lastSuccessAt: string | null;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const effective = (s: { parameters: Record<string, unknown>; proposedParameters: Record<string, unknown> | null }) => s.proposedParameters ?? s.parameters;

export type DefinitionStage =
  /** The node is no longer in the workflow: the inverse cannot pass. */
  | { stage: "gone" }
  /** The read already holds the definition wanted. */
  | { stage: "landed" }
  /** The node has run and had no proposal before: Discard edit is the inverse. */
  | { stage: "discard" }
  /** Write this definition; the API's rule makes it active or a proposal. */
  | { stage: "write"; parameters: Record<string, unknown> };

/** What putting a node's definition back needs, from the read. */
export function definitionStage(read: ReadStep[], nodeId: string, target: Definition): DefinitionStage {
  const node = read.find((s) => s.id === nodeId);
  if (!node) return { stage: "gone" };
  if (same(effective(node), effective(target)) && (node.proposedParameters === null) === (target.proposedParameters === null)) return { stage: "landed" };
  if (node.output !== null && target.proposedParameters === null && node.proposedParameters !== null && same(node.parameters, target.parameters)) return { stage: "discard" };
  return { stage: "write", parameters: effective(target) };
}

/** A moved link's two halves, in the order they are applied: each with
 * what the read says of it. */
export function relinkStages(read: ReadStep[], halves: { nodeId: string; target: Definition }[]): { nodeId: string; stage: DefinitionStage }[] {
  return halves.map((h) => ({ nodeId: h.nodeId, stage: definitionStage(read, h.nodeId, h.target) }));
}

export type RestoreStage = "add" | "order" | "place";

export interface Restore {
  operation: string;
  /** The definition to add, its name among it. */
  parameters: Record<string, unknown>;
  /** Its former place in the order; null for an add redone, which appends. */
  ordinal: number | null;
  position: Position | null;
  /** The identity an earlier attempt adopted, kept whatever the name became. */
  adopted: string | null;
  /** The ids the workflow held when this restoration began. A node among
   * them stood before the attempt, so it is never mistaken for one the
   * attempt created, however its operation and name read. */
  baseline: readonly string[];
}

/** A node brought back: which identity it has, if any, and which of its
 * stages remain. A node created under a lost answer is adopted by its
 * operation and its name as the API stores it, so no second is added —
 * and only among the nodes that were not there when the restoration
 * began, so a stranger sharing the name is never taken for it. */
export function restoreStages(read: ReadStep[], layoutSteps: Record<string, Position>, want: Restore): { id: string | null; pending: RestoreStage[] } {
  const wantedName = typeof want.parameters.name === "string" ? normalName(want.parameters.name) : null;
  // Only a node the attempt itself put there is adopted: one that stood
  // before it belongs to somebody else, and adopting it would key the
  // record's later steps onto that node instead.
  const stood = new Set(want.baseline);
  const node =
    (want.adopted && read.find((s) => s.id === want.adopted)) ??
    read.find((s) => {
      if (stood.has(s.id) || s.operation !== want.operation || wantedName === null) return false;
      const declared = typeof s.parameters.name === "string" ? normalName(s.parameters.name) : null;
      return declared === wantedName;
    }) ??
    null;
  const pending: RestoreStage[] = [];
  if (!node) {
    pending.push("add");
    // Appended at the end: the order stage is needed only when its former place is earlier.
    if (want.ordinal !== null && want.ordinal < read.length) pending.push("order");
    if (want.position !== null) pending.push("place");
    return { id: null, pending };
  }
  if (want.ordinal !== null) {
    const target = Math.max(0, Math.min(want.ordinal, read.length - 1));
    if (node.ordinal !== target) pending.push("order");
  }
  if (want.position !== null && !(node.id in layoutSteps)) pending.push("place");
  return { id: node.id, pending };
}

/** An add undone or a removal redone: remove the node, unless it is gone. */
export function removalStage(read: ReadStep[], nodeId: string): "remove" | "landed" {
  return read.some((s) => s.id === nodeId) ? "remove" : "landed";
}

export type RefusalOutcome = { kind: "failed"; message: string } | { kind: "refused"; code: string; message: string; status?: number };

export interface Verdict {
  /** Keep: the next press tries the step again. Drop: it leaves the record. */
  verdict: "keep" | "drop";
  reason: string;
}

/** The refusal codes the page itself raises that will pass later; the
 * lock among them, since unlocking finds the step where it was. */
const TRANSIENT_CODES = new Set(["run_in_flight", "invalid_draft", "unreachable", "locked"]);

/** Whether a refusal will pass later (the server unreachable, the routes'
 * changed-meanwhile conflict, a member of the run in flight, an invalid
 * draft) or cannot (the name rule, the order rule, a backward read, a
 * node no longer there). */
export function classifyRefusal(outcome: RefusalOutcome): Verdict {
  if (outcome.kind === "failed") return { verdict: "keep", reason: outcome.message };
  if (outcome.status === 409 || TRANSIENT_CODES.has(outcome.code)) return { verdict: "keep", reason: outcome.message };
  return { verdict: "drop", reason: outcome.message };
}
