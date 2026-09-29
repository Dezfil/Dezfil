"use client";
import { useCallback, useSyncExternalStore } from "react";
import type { ModelKnowledge } from "@/lib/assistant/model-knowledge";
import { chooseModel, defaultChoice, reconcile, type ModelChoice } from "./model-choice";
import { onPrivateReset, privateStateOpen } from "../../auth/private-state";

/**
 * The remembered model and effort, kept apart from the conversation and
 * apart from the active-run locator: the choice belongs to the pane, so
 * clearing the conversation, a run settling and a locator being dropped all
 * leave it alone.
 *
 * A pane mounts on each of the three pages and reads this one store, so a
 * pick made on one page is what the next page's composer shows. It is held
 * in the tab's own session storage under its own key, so a reload within
 * the tab keeps it and a fresh independent tab starts at the reported
 * default; a tab whose storage refuses simply remembers in memory
 * for as long as it lives.
 *
 * What the store holds is the raw pick. What the pane shows and what a
 * request carries both come from it through `reconcile`, so a pair the
 * status read no longer supports falls back in both places at once and
 * neither can show what the other does not send.
 */

/** The choice's own key, deliberately not the active run's: a run settling
 * clears its locator, and that must not take the choice with it. */
export const CHOICE_KEY = "dezfil.assistant.choice";

function read(): ModelChoice | null {
  if (!privateStateOpen()) return null;
  try {
    const raw = typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(CHOICE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as ModelChoice;
    return typeof value?.model === "string" && typeof value?.effort === "string" ? { model: value.model, effort: value.effort } : null;
  } catch { return null; }
}
function write(value: ModelChoice | null) {
  try {
    if (typeof sessionStorage === "undefined") return;
    if (value) sessionStorage.setItem(CHOICE_KEY, JSON.stringify({ model: value.model, effort: value.effort }));
    else sessionStorage.removeItem(CHOICE_KEY);
  } catch { /* A tab whose storage refuses keeps its memory-only choice. */ }
}

export class ModelChoiceStore {
  private choice: ModelChoice | null = read();
  private listeners = new Set<() => void>();
  get = (): ModelChoice | null => this.choice;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  set(next: ModelChoice | null) {
    if (next !== null && !privateStateOpen()) return;
    this.choice = next;
    write(next);
    for (const listener of this.listeners) listener();
  }
  /** A fresh tab's state, for tests and for nothing else. */
  resetForTests() { this.set(null); }
}

/** The tab's one remembered choice. */
export const modelChoice = new ModelChoiceStore();
onPrivateReset(() => modelChoice.set(null));

/** The selection the next message will carry, and how a pick changes it.
 * Nothing remembered is the instance's own default, so an instance that
 * offers one model behaves exactly as it does today. */
export function useModelChoice(models: ModelKnowledge[], instanceModel: string): {
  choice: ModelChoice;
  pickModel: (id: string) => void;
  pickEffort: (value: string) => void;
} {
  const store = modelChoice;
  const remembered = useSyncExternalStore(store.subscribe, store.get, store.get);
  const choice = reconcile(models, remembered, instanceModel) ?? defaultChoice(instanceModel);
  /** A pick starts from what the person can see, which after a fallback is
   * the fallen-back pair rather than the pair the tab still holds. */
  const from = useCallback(() => reconcile(models, store.get(), instanceModel) ?? defaultChoice(instanceModel), [models, instanceModel, store]);
  const pickModel = useCallback((id: string) => { store.set(chooseModel(models, from(), id)); }, [models, from, store]);
  const pickEffort = useCallback((value: string) => { store.set({ ...from(), effort: value }); }, [from, store]);
  return { choice, pickModel, pickEffort };
}
