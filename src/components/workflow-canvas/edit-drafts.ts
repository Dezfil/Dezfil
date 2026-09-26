import type { EditOutcome } from "./use-recipe-edits";
import type { SaveState } from "./use-layout-saves";

type Rejected = Extract<EditOutcome, { kind: "failed" | "refused" }>;
export type EditRejection = { outcome: Rejected; order: number };
export interface UnresolvedDraft {
  revision: number;
  parameters: Record<string, unknown>;
  /** Typed values, before name registration and inactive-field removal. */
  displayValues: Record<string, unknown>;
  field?: string;
  outcome: Rejected | null;
  refusals?: Record<string, string>;
  local?: boolean;
}
/** Node-owned records outlive panels. A landing may resolve only the
 * revision it sent; a successor's draft remains visible until it lands. */
export class EditDrafts {
  private records = new Map<string, UnresolvedDraft>();
  private failures = new Map<string, EditRejection & { state: SaveState | null }>();
  private listeners = new Set<() => void>();
  private revision = 0;
  private order = 0;
  /** One ordering for draft outcomes and a barrier's temporary structural outcome. */
  stamp = (outcome: Rejected): EditRejection => ({ outcome, order: ++this.order });
  get = (id: string): UnresolvedDraft | null => this.records.get(id) ?? null;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private changed() { for (const fn of this.listeners) fn(); }
  offer(id: string, parameters: Record<string, unknown>, field?: string): number {
    const revision = ++this.revision;
    const previous = this.records.get(id);
    // A local hold and a retry of the same payload keep what was typed.
    const displayValues = previous && (previous.local || previous.parameters === parameters) ? previous.displayValues : parameters;
    this.records.set(id, { revision, parameters, displayValues, field, outcome: null, refusals: previous?.refusals });
    this.changed();
    return revision;
  }
  hold(id: string, parameters: Record<string, unknown>, field: string) {
    const revision = this.offer(id, parameters, field);
    this.records.set(id, { ...this.records.get(id)!, local: true, displayValues: parameters });
    this.reject(id, { kind: "refused", code: "unsaved_draft", message: "The change has not been saved." }, () => {}, revision);
  }
  invalid(id: string, message: string | null) {
    const draft = this.records.get(id);
    if (!draft?.local || !message || draft.outcome?.message === message) return;
    this.reject(id, { kind: "refused", code: "unsaved_draft", message }, () => {}, draft.revision);
  }
  reject(key: string, outcome: Rejected, retry: () => void, revision?: number) {
    const current = this.records.get(key);
    if (revision !== undefined && current && current.revision > revision) return;
    this.failures.delete(key);
    this.failures.set(key, { ...this.stamp(outcome), state: outcome.kind === "failed" ? { ...outcome, retry } : null });
    const draft = this.records.get(key);
    if (draft && draft.revision === revision) {
      const refusals = outcome.kind === "refused" && outcome.code !== "unsaved_draft" && draft.field
        ? { ...draft.refusals, [draft.field]: outcome.message } : draft.refusals;
      this.records.set(key, { ...draft, outcome, refusals });
    }
    this.changed();
  }
  accept(key: string, revision?: number) {
    const draft = this.records.get(key);
    if (revision !== undefined && draft && draft.revision > revision) return;
    this.failures.delete(key);
    if (revision === undefined || draft?.revision === revision) this.records.delete(key);
    this.changed();
  }
  rejected = (window: EditRejection | null = null): Rejected | null => {
    const draft = [...this.failures.values()].at(-1);
    return (draft && (!window || draft.order > window.order) ? draft : window)?.outcome ?? null;
  };
  failure = (): Extract<SaveState, { kind: "failed" }> | null => {
    const state = [...this.failures.values()].reverse().find((f) => f.state)?.state;
    return state?.kind === "failed" ? state : null;
  };
}
