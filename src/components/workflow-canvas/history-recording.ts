import type { WorkflowStep } from "../workflow-model";
import type { Position } from "./arrange";
import { record as recorded, words, type Definition, type History, type RecipeStep } from "./canvas-history";
import type { EditNote, EditOutcome, RecipeCoordinator, RecipeEdits, RemovalOutcome, RetryPorts } from "./use-recipe-edits";

/**
 * The recording layer over the edit coordinator: the same shape the pane,
 * the panel and the link handlers already call, recording each change the
 * workflow accepts as a step. A refused, failed or unchanged change is no
 * step, and the record's own inverses travel the bare coordinator, so an
 * undo is never a step of its own.
 *
 * A moved link is two edits and one step, so a run that makes both is
 * given **its own channel**: only the edits made on that channel join its
 * step. An edit landing from anywhere else meanwhile — the panel's
 * debounce firing mid-drag is the ordinary case — travels the open
 * channel and is its own step, and a composite inside another keeps its
 * own halves. Extracted from `use-canvas-history`, where
 * one shared scope had swallowed whatever edit landed in its window.
 *
 * Every change is made **owning its own retry**: each call goes through
 * the coordinator's view that carries this layer's continuation, so the
 * whisper's Retry re-enters this layer rather than the coordinator's
 * re-issue of the raw call, and a change that succeeds at the second
 * attempt is a step like any other. Without it an edit, an add, a
 * discard or a removal that went through Retry changed the workflow with
 * nothing in the record to take it back. The continuation travels with
 * the call and is held nowhere between calls: an inverse on the wire
 * beside this layer's change keeps its own.
 *
 * Nothing of React here: the screen's ports arrive from an effect, as the
 * edit coordinator's own do, and the layer reads them when a change is
 * made rather than while the page renders.
 */

export const definitionOf = (step: WorkflowStep): Definition => ({ parameters: step.parameters, proposedParameters: step.proposedParameters });
export const effectiveOf = (d: Definition) => d.proposedParameters ?? d.parameters;

/** The coordinator as the canvas hands it on: the same shape, with the
 * channel a moved link's two edits are recorded as one step through. */
export interface RecordingEdits extends RecipeEdits {
  /** A run whose edits are one step. It is handed its own channel and
   * must make them on it; what it makes elsewhere is an ordinary step. */
  composite: (run: (scoped: RecordingEdits) => Promise<void>) => Promise<void>;
}

/** What the recording layer reads of the page, so it can hold none of it. */
export interface RecordingPorts {
  /** The coordinator itself: the road every change travels. */
  edits: RecipeCoordinator;
  /** The record as it stands, and the record after a step. */
  record: () => History;
  put: (next: History) => void;
  /** The newest definition this page knows for a node. */
  known: (nodeId: string) => Definition | null;
  /** A node's own word for the notice. */
  labelOf: (nodeId: string) => string;
  /** An operation's own word, for the word an add's notice uses. */
  operationLabel: (operation: string) => string;
  /** The word an edit's notice uses, from the change itself. */
  editLabel: (nodeId: string, before: Definition, after: Definition) => string;
  /** The newest answer this page has for a node is this one now. */
  answered: (step: WorkflowStep) => void;
  /** The page's answer for a node is forgotten: it has left the workflow. */
  forget: (nodeId: string) => void;
  /** The last success of every node a step names, as it stands now. */
  watermarksFor: (ids: string[]) => Record<string, string | null>;
  /** What a removal's step must carry, read before the call takes the
   * node away: its operation, its place in the order and its position. */
  removalFacts: (nodeId: string) => { operation: string; ordinal: number; position: Position | null };
  /** The canvas-local lock and notice read when an owned Retry re-enters
   * this recording road. */
  retry: RetryPorts;
}

/** An accepted edit with what the node held before it: the material a
 * step is made of, whether it becomes its own or one half of a
 * composite's. */
interface Half {
  nodeId: string;
  before: Definition | null;
  after: Definition;
}

/** The layer and the seat its ports take. */
export interface Recording {
  /** The coordinator the pane, the panel and the link handlers call. */
  edits: RecordingEdits;
  /** The screen's latest ports, kept in step by an effect. */
  setPorts: (ports: RecordingPorts) => void;
}

export function makeRecording(): Recording {
  let held: RecordingPorts | null = null;
  /** The ports as they stand. A change can only come from the screen,
   * which sets them as it mounts, so an unset seat is not a state the
   * page can reach. */
  const p = (): RecordingPorts => {
    if (!held) throw new Error("The canvas's record was used before the screen gave it its ports.");
    return held;
  };
  /** A recording-owned Retry re-enters this layer only while the canvas
   * is open. Refusing it changes neither the frame whisper nor the work
   * it still carries, so the same continuation remains usable later. */
  const retry = (run: () => void): (() => void) => () => {
    const ports = p().retry;
    const reason = ports.lockReason();
    if (reason) {
      ports.say(reason, "bad");
      return;
    }
    run();
  };
  const recordEdit = (nodeId: string, before: Definition, after: Definition, session: string | null) => {
    p().put(
      recorded(p().record(), {
        kind: "recipe",
        nodeId,
        watermarks: p().watermarksFor([nodeId]),
        op: { kind: "edit", before, after, session },
        label: p().editLabel(nodeId, before, after),
      } satisfies RecipeStep),
    );
  };

  /** The definition each node will hold once the change last made on it
   * has settled: the `before` of the next change on that node. A node's
   * changes are serialized by its lane, so the one made before lands
   * first and its answer is what the next one writes over; what the
   * page *knew* when the next one was made is older than that while
   * the earlier one is still on the wire, and a step measured from it
   * would take the earlier change back with its own (found at review).
   * Held only while a change is in flight. */
  const chain = new Map<string, Promise<Definition | null>>();
  /** A change on a node begins: the definition it will find before it,
   * once the change before it has settled, and the promise it settles
   * for the change after it, with what the node holds then. */
  function begin(stepId: string): { before: () => Promise<Definition | null>; settle: (held: Definition | null) => void } {
    const prior = chain.get(stepId) ?? null;
    const knownNow = p().known(stepId);
    let settle!: (held: Definition | null) => void;
    const mine = new Promise<Definition | null>((resolve) => {
      settle = resolve;
    });
    chain.set(stepId, mine);
    return {
      before: async () => (prior ? await prior : null) ?? knownNow,
      settle: (held) => {
        settle(held);
        if (chain.get(stepId) === mine) chain.delete(stepId);
      },
    };
  }

  /** One edit through the coordinator. Accepted, it goes to the sink the
   * channel carries — a composite's halves — or, on the open channel,
   * becomes its own step. */
  async function editVia(sink: ((half: Half) => void) | null, stepId: string, parameters: Record<string, unknown>, note?: EditNote): Promise<EditOutcome> {
    const link = begin(stepId);
    let held: Definition | null = null;
    try {
      const outcome = await p()
        .edits.owned(retry(() => void editVia(sink, stepId, parameters, note)))
        .edit(stepId, parameters, note);
      const before = await link.before();
      held = before;
      if (outcome.kind !== "accepted" || !outcome.step) return outcome;
      const after = definitionOf(outcome.step);
      held = after;
      p().answered(outcome.step);
      if (sink) sink({ nodeId: stepId, before, after });
      else if (before) recordEdit(stepId, before, after, note?.session ?? null);
      return outcome;
    } finally {
      link.settle(held);
    }
  }

  const add = async (input: { operation: string; parameters: Record<string, unknown> }, note?: EditNote): Promise<EditOutcome> => {
    const outcome = await p()
      .edits.owned(retry(() => void add(input, note)))
      .add(input, note);
    if (outcome.kind !== "accepted" || !outcome.step) return outcome;
    const step = outcome.step;
    p().answered(step);
    const label = p().operationLabel(step.operation);
    p().put(
      recorded(p().record(), {
        kind: "recipe",
        nodeId: step.id,
        watermarks: { [step.id]: step.lastSuccessAt ?? null },
        // The position joins when the tile takes its spot (`placed`).
        op: { kind: "add", operation: step.operation, parameters: step.parameters, position: null, pasted: note?.pasted === true },
        label: note?.pasted === true ? words.pasted(label) : words.added(label),
      } satisfies RecipeStep),
    );
    return outcome;
  };

  const discard = async (stepId: string): Promise<EditOutcome> => {
    const link = begin(stepId);
    let held: Definition | null = null;
    try {
      const outcome = await p()
        .edits.owned(retry(() => void discard(stepId)))
        .discard(stepId);
      // What the discard dropped: the proposal the node held once an edit
      // on the wire before it had landed.
      const before = await link.before();
      held = before;
      if (outcome.kind !== "accepted" || !outcome.step) return outcome;
      const after = definitionOf(outcome.step);
      held = after;
      p().answered(outcome.step);
      if (before) {
        p().put(
          recorded(p().record(), {
            kind: "recipe",
            nodeId: stepId,
            watermarks: p().watermarksFor([stepId]),
            op: { kind: "discard", before, after },
            label: words.discarded(p().labelOf(stepId)),
          } satisfies RecipeStep),
        );
      }
      return outcome;
    } finally {
      link.settle(held);
    }
  };

  const remove = async (stepId: string): Promise<RemovalOutcome> => {
    // Read before the call: the node leaves the graph with the answer.
    const label = p().labelOf(stepId);
    const { operation, ordinal, position } = p().removalFacts(stepId);
    const watermarks = p().watermarksFor([stepId]);
    const link = begin(stepId);
    let before: Definition | null = null;
    try {
      const outcome = await p()
        .edits.owned(retry(() => void remove(stepId)))
        .remove(stepId);
      // The definition the removal took away: what the node held once an
      // edit on the wire before it had landed.
      before = await link.before();
      if (outcome.kind !== "accepted") return outcome;
      p().forget(stepId);
      if (before && operation !== "") {
        p().put(
          recorded(p().record(), {
            kind: "recipe",
            nodeId: stepId,
            watermarks,
            // The definition as the panel showed it: its name and its
            // named inputs among it.
            op: { kind: "remove", operation, parameters: effectiveOf(before), position, ordinal, dataset: outcome.answer.output?.state ?? null },
            label: words.removed(label),
          } satisfies RecipeStep),
        );
      }
      return outcome;
    } finally {
      // A refused removal leaves the node as it was; an accepted one
      // takes it away, and nothing follows it on the chain.
      link.settle(before);
    }
  };

  async function composite(run: (scoped: RecordingEdits) => Promise<void>): Promise<void> {
    // This run's own halves, held here and nowhere shared: an edit that
    // lands from elsewhere while the two are in flight never joins them.
    const halves: Half[] = [];
    // A half that lands after the composite has closed — one of its edits
    // retried from the whisper, long after — is nobody's half: it stands
    // as the edit it is.
    let open = true;
    const sink = (half: Half) => {
      if (open) halves.push(half);
      else if (half.before) recordEdit(half.nodeId, half.before, half.after, null);
    };
    try {
      await run(channel(sink));
    } finally {
      open = false;
      const [taker, holder] = halves;
      if (taker && holder && taker.before && holder.before) {
        p().put(
          recorded(p().record(), {
            kind: "recipe",
            nodeId: taker.nodeId,
            watermarks: p().watermarksFor([taker.nodeId, holder.nodeId]),
            // The reader that took the link is detached second when the
            // step is undone; the one that lost it is put back first.
            op: {
              kind: "relink",
              holder: { nodeId: holder.nodeId, before: holder.before, after: holder.after },
              taker: { nodeId: taker.nodeId, before: taker.before, after: taker.after },
            },
            label: words.linkMoved(p().labelOf(taker.nodeId)),
          } satisfies RecipeStep),
        );
      } else if (taker && !holder && taker.before) {
        // Only one half landed (a move within one node, or a second half
        // refused): it stands as the edit it is.
        recordEdit(taker.nodeId, taker.before, taker.after, null);
      }
    }
  }

  /** The coordinator over one channel: the open one records each edit as
   * its own step, a composite's collects them for its. */
  function channel(sink: ((half: Half) => void) | null): RecordingEdits {
    // Each member delegates when it is called, never when the channel is
    // made: the seat is filled by the screen's effect, after this.
    return {
      add,
      edit: (stepId, parameters, note) => editVia(sink, stepId, parameters, note),
      discard,
      remove,
      reorder: (stepId, ordinal) => p().edits.reorder(stepId, ordinal),
      get drafts() { return p().edits.drafts; },
      idle: () => p().edits.idle(),
      settled: () => p().edits.settled(),
      composite,
    };
  }

  return {
    edits: channel(null),
    setPorts: (ports) => {
      held = ports;
    },
  };
}
