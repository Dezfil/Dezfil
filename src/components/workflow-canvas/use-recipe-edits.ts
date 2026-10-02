"use client";

import { useEffect, useMemo } from "react";
import type { WorkflowStep } from "../workflow-model";
import { editCall as call, UncertainEdits, type EditAnswer as Answer } from "./edit-transport";
import { EditDrafts, type EditRejection } from "./edit-drafts";
import { WorkflowDocument } from "./workflow-document";
import { fieldIntent } from "../document-sequence";
import type { SaveState } from "./use-layout-saves";

/**
 * The recipe-edit coordinator: every change is one documented call — add a
 * step, edit a step's whole definition, discard its pending edit, remove it
 * — made as it is made. A node's edits are serialized (its lane); a change
 * the API refuses comes back to the field that made it with the API's
 * reason; a network failure keeps the value and offers Retry through the
 * frame's whisper. Every accepted change tells the screen, which re-reads
 * the recipe: the recipe's state is the API's, never a client's guess.
 */

export type EditOutcome =
  | { kind: "accepted"; step: WorkflowStep | null; applied?: "active" | "proposed" }
  | { kind: "superseded" }
  | { kind: "refused"; code: string; message: string; status?: number }
  | { kind: "failed"; message: string };

export interface RemovalAnswer {
  removed: string;
  output: { name: string; state: "exists" | "deleted" | "never" } | null;
  readers: { id: string; operation: string; label: string }[];
  outputsRemain: boolean;
  message: string;
}

export type RemovalOutcome = { kind: "accepted"; answer: RemovalAnswer } | Exclude<EditOutcome, { kind: "accepted" }>;

/** What a caller can tell the record about the change it is making (spec
 * the field an edit came from and the focus session it was typed
 * in, so a slow typist's sends are one step, and whether an add came from
 * a paste, for the word its notice uses. The coordinator itself never
 * reads it; the recording layer over it does. */
export interface EditNote {
  field?: string;
  session?: string | null;
  pasted?: boolean;
}

/** A step to add, and the workflow its values were written in when that is
 * another one. */
export type AddInput = { operation: string; parameters: Record<string, unknown>; writtenIn?: { kind: "workflow"; id: string } };

export interface RecipeEdits {
  /** Shared unresolved drafts; wrappers pass this read/subscription seat through. */
  readonly drafts?: EditDrafts;
  readonly document?: WorkflowDocument;
  /** Add a step; resolves with the step the API made, or the refusal. A
   * pasted node from another workflow says where it was written. */
  add: (input: AddInput, note?: EditNote) => Promise<EditOutcome>;
  /** Replace a step's definition; serialized per node. */
  edit: (stepId: string, parameters: Record<string, unknown>, note?: EditNote) => Promise<EditOutcome>;
  discard: (stepId: string) => Promise<EditOutcome>;
  remove: (stepId: string) => Promise<RemovalOutcome>;
  /** Move a step to a place in the order: the record's
   * restoration of a removed node needs it. */
  reorder: (stepId: string, ordinal: number) => Promise<EditOutcome>;
  /** Every change still in flight, on every node: the pre-run barrier's wait. */
  idle: () => Promise<void>;
  /** Await every mutation and return the newest unresolved parameter outcome
   * or structural rejection that landed during this call. */
  settled: () => Promise<EditOutcome | null>;
}

/** The coordinator the screen made: the calls above, and a view of them
 * that carries a caller's own continuation. */
export interface RecipeCoordinator extends RecipeEdits {
  /** The same calls, each offering *this* continuation to the frame's
   * whisper when it fails, instead of the coordinator's own re-issue of
   * the raw call: an inverse's Retry resumes the history operation,
   * which reads the recipe first and applies no stage twice, and a
   * recorded change's Retry re-enters the recording layer. The
   * continuation travels **with each call**, never through a slot read
   * when a call is made: two operations overlap routinely (an inverse
   * issues its request after a read, and the canvas stays editable
   * meanwhile), and a failure must be offered its own caller's Retry,
   * never whichever caller's block happened to stand open. */
  owned: (retry: () => void) => RecipeEdits;
  /** The canvas-local lock and notice read when a Retry re-enters a raw
   * coordinator road. The coordinator is made by the screen above the
   * canvas, so the canvas fills this seat after it mounts. */
  setRetryPorts: (ports: RetryPorts) => void;
}

interface Ports {
  onState: (state: SaveState) => void;
  onAccepted: () => void;
}

export interface RetryPorts {
  lockReason: () => string | null;
  say: (text: string, tone?: "bad") => void;
}

const UNBOUND_RETRY_PORTS: RetryPorts = {
  lockReason: () => {
    throw new Error("The recipe editor's Retry was used before the canvas gave it its ports.");
  },
  say: () => {
    throw new Error("The recipe editor's Retry was used before the canvas gave it its ports.");
  },
};

type Pending = { revision: number; parameters: Record<string, unknown>; owner: (() => void) | null };

/** The coordinator as a plain object: its methods call one another for
 * Retry, which a hook's memoized callbacks cannot do without a ref.
 * Exported for its tests, which run it over a fetch they answer by hand;
 * the screen makes it through `useRecipeEdits`. */
export class RecipeEditor implements RecipeCoordinator {
  private uncertain: UncertainEdits;
  readonly drafts = new EditDrafts();
  private latest = new Map<string, Record<string, unknown>>();
  /** Every mutation on the wire, with what it answered. */
  private inflight = new Set<Promise<EditOutcome | RemovalOutcome>>();
  private windows = new Set<{ rejected: EditRejection | null }>();

  private track<T extends EditOutcome | RemovalOutcome>(p: Promise<T>): Promise<T> {
    const tracked = p.then((outcome) => {
      return outcome;
    });
    this.inflight.add(tracked);
    void tracked.finally(() => this.inflight.delete(tracked));
    return tracked;
  }

  private current: Ports;
  private retryCurrent: RetryPorts;

  constructor(
    private readonly id: string,
    ports: Ports,
    retryPorts: RetryPorts,
    readonly document = new WorkflowDocument(id),
  ) {
    this.current = ports;
    this.uncertain = new UncertainEdits(`/api/recipes/${id}/steps`, (path, init) => this.document.send(String(path), init ?? {}));
    this.retryCurrent = retryPorts;
  }

  /** The screen's latest callbacks, kept in step by an effect. */
  setPorts(ports: Ports): void {
    this.current = ports;
  }

  /** The canvas's latest lock reader and notice. */
  setRetryPorts(ports: RetryPorts): void {
    this.retryCurrent = ports;
  }

  private ports(): Ports {
    return this.current;
  }

  /** A coordinator-owned fallback Retry. The lock is read at the press,
   * never at the failed attempt, so a failure stays recoverable and the
   * same Retry can leave after unlock. */
  private retry(run: () => void): () => void {
    return () => {
      const reason = this.retryCurrent.lockReason();
      if (reason) {
        this.retryCurrent.say(reason, "bad");
        return;
      }
      run();
    };
  }

  /** A refused or failed answer, settled: the whisper told, the outcome
   * made. The retry is the one the call carried — its caller's own
   * continuation when it had one, the raw re-issue otherwise. */
  private published: SaveState | null = null;
  private publish(state: SaveState): void {
    const next = this.drafts.failure() ?? state;
    if (next === this.published) return;
    this.published = next;
    this.ports().onState(next);
  }

  private settle(result: Answer, retry: () => void, key?: string, revision?: number): EditOutcome {
    if (result.ok) return { kind: "accepted", step: null };
    const outcome = "refused" in result
      ? { kind: "refused" as const, ...result.refused }
      : { kind: "failed" as const, message: result.failed };
    if (key !== undefined) this.drafts.reject(key, outcome, retry, revision);
    else {
      const rejected = this.drafts.stamp(outcome);
      for (const window of this.windows) window.rejected = rejected;
      if (outcome.kind === "failed") {
        // Structural failures need their own Retry even while a draft fails.
        // The next aggregate publish restores the stored draft's notice.
        const state = { ...outcome, retry };
        this.published = state;
        this.ports().onState(state);
        return outcome;
      }
    }
    if ("refused" in result) {
      // Refused is not a failure to save: the whisper is quiet, the field speaks.
      this.publish({ kind: "saved" });
      return outcome;
    }
    this.publish({ kind: "failed", message: result.failed, retry });
    return outcome;
  }

  private async sendEdit(stepId: string, pending: Pending): Promise<EditOutcome> {
    const { parameters, owner, revision } = pending;
    this.publish({ kind: "saving" });
    const result = await this.uncertain.send(stepId, parameters);
    if (result.ok) {
      const body = result.body as { step: WorkflowStep; applied: "active" | "proposed" };
      this.drafts.accept(stepId, revision);
      this.publish({ kind: "saved" });
      this.ports().onAccepted();
      return { kind: "accepted", step: body.step, applied: body.applied };
    }
    return this.settle(result, owner ?? this.retry(() => {
      const again = this.latest.get(stepId);
      if (again) void this.edit(stepId, again);
    }), stepId, revision);
  }

  private editWith(stepId: string, parameters: Record<string, unknown>, owner: (() => void) | null, note?: EditNote): Promise<EditOutcome> {
    const revision = this.drafts.offer(stepId, parameters, note?.field);
    const step = this.document.step(stepId);
    const before = this.latest.get(stepId) ?? step?.proposedParameters ?? step?.parameters;
    const compose = fieldIntent(before, parameters);
    this.latest.set(stepId, parameters);
    return this.track(this.document.enqueue(() => {
      const accepted = this.document.step(stepId);
      const next = compose(accepted?.proposedParameters ?? accepted?.parameters) ?? parameters;
      return this.sendEdit(stepId, { parameters: next, owner, revision });
    }));
  }

  edit = (stepId: string, parameters: Record<string, unknown>, note?: EditNote): Promise<EditOutcome> => this.editWith(stepId, parameters, null, note);

  add = (input: AddInput): Promise<EditOutcome> => this.track(this.document.enqueue(() => this.addNow(input, null)));

  private addNow = async (input: AddInput, owner: (() => void) | null): Promise<EditOutcome> => {
    this.publish({ kind: "saving" });
    const result = await call(`/api/recipes/${this.id}/steps`, { method: "POST", body: JSON.stringify(input) }, "add the node", (path, init) => this.document.send(String(path), init ?? {}));
    if (result.ok) {
      this.publish({ kind: "saved" });
      this.ports().onAccepted();
      return { kind: "accepted", step: (result.body as { step: WorkflowStep }).step };
    }
    return this.settle(result, owner ?? this.retry(() => void this.add(input)));
  };

  discard = (stepId: string): Promise<EditOutcome> => this.track(this.document.enqueue(() => this.discardNow(stepId, null)));

  private discardNow = async (stepId: string, owner: (() => void) | null): Promise<EditOutcome> => {
    this.publish({ kind: "saving" });
    const result = await call(`/api/recipes/${this.id}/steps/${stepId}/proposal`, { method: "DELETE" }, "discard the edit", (path, init) => this.document.send(String(path), init ?? {}));
    if (result.ok) {
      this.drafts.accept(stepId);
      this.publish({ kind: "saved" });
      this.ports().onAccepted();
      return { kind: "accepted", step: (result.body as { step: WorkflowStep }).step };
    }
    return this.settle(result, owner ?? this.retry(() => void this.discard(stepId)));
  };

  reorder = (stepId: string, ordinal: number): Promise<EditOutcome> => this.track(this.document.enqueue(() => this.reorderNow(stepId, ordinal, null)));

  private reorderNow = async (stepId: string, ordinal: number, owner: (() => void) | null): Promise<EditOutcome> => {
    // A structural change waits for the node's edits to land.
    this.publish({ kind: "saving" });
    const result = await call(`/api/recipes/${this.id}/steps/${stepId}/move`, { method: "POST", body: JSON.stringify({ ordinal }) }, "move the node", (path, init) => this.document.send(String(path), init ?? {}));
    if (result.ok) {
      this.publish({ kind: "saved" });
      this.ports().onAccepted();
      return { kind: "accepted", step: null };
    }
    return this.settle(result, owner ?? this.retry(() => void this.reorder(stepId, ordinal)));
  };

  /** The calls, each carrying this continuation: the view a caller that
   * owns its Retry makes its calls on. Nothing is held between calls. */
  owned = (retry: () => void): RecipeEdits => ({
    document: this.document,
    drafts: this.drafts,
    add: (input) => this.track(this.document.enqueue(() => this.addNow(input, retry))),
    edit: (stepId, parameters, note) => this.editWith(stepId, parameters, retry, note),
    discard: (stepId) => this.track(this.document.enqueue(() => this.discardNow(stepId, retry))),
    remove: (stepId) => this.track(this.document.enqueue(() => this.removeNow(stepId, retry))),
    reorder: (stepId, ordinal) => this.track(this.document.enqueue(() => this.reorderNow(stepId, ordinal, retry))),
    idle: this.idle,
    settled: this.settled,
  });

  idle = async (): Promise<void> => {
    await this.document.idle();
  };

  settled = async (): Promise<EditOutcome | null> => {
    const window = { rejected: null as EditRejection | null };
    this.windows.add(window);
    try {
      // Mutations can queue more mutations; wait until nothing is on the wire.
      while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
      await this.idle();
      return this.drafts.rejected(window.rejected);
    } finally {
      this.windows.delete(window);
    }
  };

  remove = (stepId: string): Promise<RemovalOutcome> => this.track(this.document.enqueue(() => this.removeNow(stepId, null)));

  private removeNow = async (stepId: string, owner: (() => void) | null): Promise<RemovalOutcome> => {
    // A structural change waits for the node's edits to land.
    this.publish({ kind: "saving" });
    const result = await call(`/api/recipes/${this.id}/steps/${stepId}`, { method: "DELETE" }, "remove the node", (path, init) => this.document.send(String(path), init ?? {}));
    if (result.ok) {
      this.drafts.accept(stepId);
      this.latest.delete(stepId);
      this.publish({ kind: "saved" });
      this.ports().onAccepted();
      return { kind: "accepted", answer: result.body as RemovalAnswer };
    }
    return this.settle(result, owner ?? this.retry(() => void this.remove(stepId))) as RemovalOutcome;
  };
}

export function useRecipeEdits({ id, onState, onAccepted, document }: { id: string; document?: WorkflowDocument } & Ports): RecipeCoordinator {
  // Made once per workflow; the screen's callbacks follow through an effect.
  // The canvas binds the live seat in its first effect. Until then the
  // editor fails closed instead of giving a Retry an open road.
  const editor = useMemo(() => new RecipeEditor(id, { onState, onAccepted }, UNBOUND_RETRY_PORTS, document), [id, document]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    editor.setPorts({ onState, onAccepted });
  }, [editor, onAccepted, onState]);
  return editor;
}
