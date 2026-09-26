/**
 * When a key belongs to a control of its own, and not to the canvas.
 * Inside an editable control the chord is that control's own undo, and
 * inside an open dialog it is the dialog's; everywhere else on the
 * workflow page the canvas takes it. The builder's text-editing rule,
 * widened to the select, the content-editable and the note's own field,
 * which is a textarea.
 *
 * Shared by the record and the clipboard so one gesture cannot mean two
 * things: Copy adds a text selection to this rule, since selected text
 * anywhere has its own Copy, where undo has a meaning only inside a
 * field. Pure but for the document it asks about; no React.
 */
export function controlOwnsKey(target: EventTarget | null): boolean {
  // An event can target the document itself (the smoke saw a paste do
  // it with a node wrapper focused); only an element can own a key.
  const t = target instanceof Element ? (target as HTMLElement) : null;
  if (t && (t.closest('input, textarea, select, [contenteditable="true"]') || t.isContentEditable)) return true;
  return document.querySelector("[data-dialog-host] [role='dialog']") !== null;
}
