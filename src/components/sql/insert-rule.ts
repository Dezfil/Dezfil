/**
 * Insert into editor: a proposal replaces the draft only while the draft
 * still equals the draft its request carried; otherwise the current draft
 * is preserved, the proposal is appended below it and selected, and the
 * block says the draft changed. Both outcomes are one undoable step;
 * Insert executes nothing. Pure, beside the draft's other ownership rules
 * in `sql-draft.ts`.
 */
export interface InsertWrite {
  text: string;
  /** The inserted text's range in the new document; the editor selects it
   * when the proposal was appended, so the person sees where it landed. */
  from: number;
  to: number;
  outcome: "replaced" | "appended";
}

export function insertProposal(currentDraft: string, originDraft: string, proposal: string): InsertWrite {
  if (currentDraft === originDraft) {
    return { text: proposal, from: 0, to: proposal.length, outcome: "replaced" };
  }
  const gap = currentDraft === "" ? "" : currentDraft.endsWith("\n") ? "\n" : "\n\n";
  const text = currentDraft + gap + proposal;
  return { text, from: currentDraft.length + gap.length, to: text.length, outcome: "appended" };
}
