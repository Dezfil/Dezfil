import type { GeometryFormat, GeometryRecord } from "@/lib/geometry-evidence";
import { GeometryApiError, type GeometryClient } from "./client";
import { openingChoice } from "./opening-choice";
import { chooseProjection, previewable, requestChoice, setColumn, setFormat, swapPair, typeOtherCode } from "./projection";
import type { GeometryInspection, GeometryPreview, GeometrySetResult, PanelChoice, SeedChoice } from "./types";

export interface PreviewState {
  /** `idle`: nothing asked for (the native path before a projection, an
   * incomplete choice). The answer is kept while the next one is in
   * flight and after a failure; it is what the page keeps drawing. */
  status: "idle" | "pending" | "ready" | "failed";
  /** The key of the latest request: the read revision and the request choice. */
  key: string | null;
  answer: GeometryPreview | null;
  answerKey: string | null;
  /** The record of the inspection the answer was read against: its CRS
   * context, kept with the answer until the answer is replaced, so a
   * stale-revision re-read that installs another record cannot relabel a
   * retained answer while the replacement is in flight. */
  answerRecord: GeometryRecord | null;
  /** A failed preview's sentence, as the API worded it. */
  message: string | null;
}

export interface PanelState {
  phase: "closed" | "opening" | "open";
  /** The inspection's refusal when the panel could not open: the page shows it. */
  openError: string | null;
  inspection: GeometryInspection | null;
  choice: PanelChoice;
  mode: "first" | "change";
  /** The projection field is marked and holds no code (the native path). */
  marked: boolean;
  preview: PreviewState;
  applying: boolean;
  /** A stale revision is being re-read: Apply stays off until the new
   * revision's own preview answers. */
  rereading: boolean;
  /** The apply's refusal, as the API worded it; cleared by the next change. */
  refusal: string | null;
}

export interface TableFacts {
  geometryColumn: string | null;
  crsAssumed: boolean;
}

export interface PanelController {
  getState(): PanelState;
  subscribe(listener: () => void): () => void;
  /** The page's hand-off after a successful apply; the page re-reads. */
  configure(callbacks: { onApplied: (result: GeometrySetResult) => void; onOpen?: () => void }): void;
  /** Open on the dataset's facts as the page read them at that moment;
   * the assumed chip's door marks the projection field. */
  open(table: TableFacts, seed?: SeedChoice | null, options?: { markProjection?: boolean }): Promise<void>;
  /** The open-with-panel address: opens once per dataset, so the
   * page's re-read after an apply, which mounts its screen again under the
   * same address, cannot reopen what the apply closed. */
  openByAddress(table: TableFacts): Promise<void>;
  setFormat(format: GeometryFormat): void;
  setColumn(index: 0 | 1, name: string): void;
  swap(): void;
  chooseProjection(value: string): void;
  typeOtherCode(text: string): void;
  apply(): Promise<void>;
  cancel(): void;
  /** Dismiss the shown refusal, or the inspection's; the choice stays. */
  dismiss(): void;
}

const EMPTY_CHOICE: PanelChoice = { format: "pair", columns: [], projection: { kind: "implicit", code: null, text: "" } };
const IDLE: PreviewState = { status: "idle", key: null, answer: null, answerKey: null, answerRecord: null, message: null };

export const CLOSED_STATE: PanelState = {
  phase: "closed", openError: null, inspection: null, choice: EMPTY_CHOICE, mode: "first", marked: false,
  preview: IDLE, applying: false, rereading: false, refusal: null,
};

export const previewKey = (revision: string, choice: PanelChoice) => `${revision}|${JSON.stringify(requestChoice(choice))}`;

export const readableRows = (answer: GeometryPreview) => answer.sample.rows.filter((r) => r.status === "readable").length;

/** Apply is on only with a successful, applicable preview for the current
 * choice and the read revision: a pending or failed preview inherits
 * nothing from an earlier one, the API's own verdict holds, and no sampled
 * row readable is off as drawn. */
export function applyEnabled(state: PanelState): boolean {
  const { preview, inspection, choice, applying, rereading, phase } = state;
  if (phase !== "open" || applying || rereading || inspection === null || preview.status !== "ready" || preview.answer === null) return false;
  const key = previewKey(inspection.revision, choice);
  return preview.answerKey === key && preview.key === key && preview.answer.revision === inspection.revision
    && preview.answer.canApply && readableRows(preview.answer) > 0;
}

const sentence = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

/**
 * The panel's state, a thin client over operations (plan): the inspection
 * it opened on, the choice with the projection it carries, the keyed
 * preview (every answer stamped with its attempt, so a superseded one is
 * not this attempt's truth: the use-catalog-tables pattern), the apply in
 * flight and the refusal to show. Pure of React, so the unit tests hold it
 * without a DOM.
 */
export function createPanelController({ client, name, onOpen: initialOnOpen }: {
  client: GeometryClient;
  name: string;
  onOpen?: () => void;
}): PanelController {
  let state: PanelState = CLOSED_STATE;
  let table: TableFacts = { geometryColumn: null, crsAssumed: false };
  let onOpen = initialOnOpen;
  let onApplied: (result: GeometrySetResult) => void = () => {};
  const listeners = new Set<() => void>();
  let attempt = 0;
  // The generation of the panel's opening: every open, cancel and close advances it, so an
  // inspection that was asked for by an earlier opening, or a re-read for one, decides nothing once
  // it lands: an older success cannot discard a newer opening's seed, an older failure cannot close
  // a newer panel.
  let generation = 0;
  let addressOpened = false;
  const set = (patch: Partial<PanelState>) => {
    state = { ...state, ...patch };
    for (const l of listeners) l();
  };

  /** Ask for a preview of the current choice, or clear the preview when
   * the choice cannot be sent; either way an older answer is retired. */
  const refresh = () => {
    const mine = ++attempt;
    const { inspection, choice } = state;
    if (inspection === null) return;
    if (!previewable(choice)) {
      set({ preview: IDLE });
      return;
    }
    const key = previewKey(inspection.revision, choice);
    const record = inspection.geometryRecord;
    set({ preview: { ...state.preview, status: "pending", key, message: null } });
    client.preview(name, inspection.revision, requestChoice(choice)).then(
      (answer) => {
        if (mine !== attempt) return;
        set({ preview: { status: "ready", key, answer, answerKey: key, answerRecord: record, message: null } });
      },
      (error: unknown) => {
        if (mine !== attempt) return;
        set({ preview: { ...state.preview, status: "failed", key, message: sentence(error, "The preview could not be read.") } });
        if (error instanceof GeometryApiError && error.code === "input_changed") void reread();
      },
    );
  };

  /** A stale revision: read the inspection again, then preview the same
   * choice against it before the next attempt, rather than retrying blind. */
  const reread = async () => {
    if (state.rereading || state.phase !== "open") return;
    const mine = generation;
    const current = () => mine === generation && state.phase === "open";
    set({ rereading: true });
    try {
      const inspection = await client.inspect(name);
      if (!current()) return;
      set({ inspection });
      refresh();
    } catch (error) {
      if (current()) set({ refusal: sentence(error, "The dataset could not be read.") });
    } finally {
      if (current()) set({ rereading: false });
    }
  };

  const change = (choice: PanelChoice, patch: Partial<PanelState> = {}) => {
    if (state.phase !== "open" || state.applying) return;
    set({ choice, refusal: null, ...patch });
    refresh();
  };

  const open = async (facts: TableFacts, seed: SeedChoice | null = null, options: { markProjection?: boolean } = {}) => {
      onOpen?.();
      table = facts;
      attempt += 1;
      const mine = ++generation;
      set({ ...CLOSED_STATE, phase: "opening" });
      let inspection: GeometryInspection;
      try {
        inspection = await client.inspect(name);
      } catch (error) {
        if (mine !== generation) return;
        set({ ...CLOSED_STATE, openError: sentence(error, "The dataset could not be read.") });
        return;
      }
      if (mine !== generation || state.phase !== "opening") return;
      const opening = openingChoice({ inspection, table, seed });
      set({ phase: "open", inspection, choice: opening.choice, mode: opening.mode, marked: opening.marked || options.markProjection === true, preview: IDLE });
      refresh();
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    configure(callbacks) {
      onApplied = callbacks.onApplied;
      onOpen = callbacks.onOpen;
    },
    open,
    async openByAddress(facts) {
      if (addressOpened) return;
      addressOpened = true;
      await open(facts);
    },
    setFormat(format) {
      const { inspection, choice } = state;
      if (inspection === null) return;
      change(setFormat(choice, format, inspection.columns, table.geometryColumn));
    },
    setColumn(index, column) {
      change(setColumn(state.choice, index, column));
    },
    swap() {
      change(swapPair(state.choice));
    },
    chooseProjection(value) {
      // A chosen code answers the marked field; the mark returns
      // only through the API's own projection_required issue.
      change(chooseProjection(state.choice, value), { marked: false });
    },
    typeOtherCode(text) {
      change(typeOtherCode(state.choice, text));
    },
    async apply() {
      if (!applyEnabled(state) || state.inspection === null) return;
      const { inspection, choice } = state;
      set({ applying: true, refusal: null });
      try {
        const result = await client.set(name, inspection.revision, requestChoice(choice));
        if (state.phase !== "open") return;
        attempt += 1;
        generation += 1;
        set({ ...CLOSED_STATE });
        onApplied(result);
      } catch (error) {
        if (state.phase !== "open") return;
        set({ applying: false, refusal: sentence(error, "The geometry could not be set.") });
        if (error instanceof GeometryApiError && error.code === "input_changed") await reread();
      }
    },
    cancel() {
      attempt += 1;
      generation += 1;
      set({ ...CLOSED_STATE });
    },
    dismiss() {
      set({ refusal: null, openError: null });
    },
  };
}
