import type { PageFacts } from "./talking-about";

/**
 * The entry chips: on the workflow canvas, while the transcript is
 * empty, two ways in that send their words as the person's own message
 * with the page's context. Explain this node stands while a recipe step
 * is selected (a source or a note supplies none); Diagnose the last run
 * once a run was observed. Both leave once the conversation has a turn.
 * Pure.
 */
export type EntryIcon = "explain" | "diagnose";
export interface EntryChip { key: string; label: string; icon: EntryIcon }

export const EXPLAIN_LABEL = "Explain this node";
export const DIAGNOSE_LABEL = "Diagnose the last run";

export function entryChips(facts: PageFacts | undefined, transcriptEmpty: boolean): EntryChip[] {
  if (!transcriptEmpty || facts?.page !== "workflow") return [];
  const chips: EntryChip[] = [];
  if (facts.selectedStepLabel !== null) chips.push({ key: "explain", label: EXPLAIN_LABEL, icon: "explain" });
  if (facts.run !== null) chips.push({ key: "diagnose", label: DIAGNOSE_LABEL, icon: "diagnose" });
  return chips;
}
