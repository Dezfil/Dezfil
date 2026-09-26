/**
 * A field's focus session: the run of changes one field takes while focus
 * stays where it is, named so the record folds them into one step and a
 * slow typist's sends are not five. A session ends when focus leaves the
 * element it was minted on, so the same field returned to opens another
 * and takes another press to undo. Extracted from the panel's draft by
 * an earlier shape, where a session had no end and two visits to one field
 * merged.
 *
 * Pure: the focused element is read by the caller and handed in, and
 * focus leaving is reported by the caller. Nothing of the DOM here.
 */
export interface Sessions {
  /** The session a change in this field belongs to, minted at the change:
   * the same one while the field and the element focus rests on are the
   * ones it was minted for. */
  mint: (at: string, on: Element | null) => string;
  /** Focus left this element: a change made on it after this opens a new
   * session, whether or not focus comes back. */
  left: (el: unknown) => void;
}

export function makeSessions(): Sessions {
  let held: { at: string; on: Element | null; id: string } | null = null;
  return {
    mint: (at, on) => {
      if (held && held.at === at && held.on === on) return held.id;
      const id = `${at}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      held = { at, on, id };
      return id;
    },
    left: (el) => {
      if (held && held.on === el) held = null;
    },
  };
}
