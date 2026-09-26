import type { ClipboardItem } from "./clipboard-items";
import { readClipboardItem } from "./clipboard-items";

/** What the page remembers of its own last copy. */
export interface LocalCopy {
  item: ClipboardItem | null;
  /** Whether the system write of `item` succeeded. */
  systemWrote: boolean;
  /** The text of this page's last SUCCESSFUL system write. */
  lastWritten: string | null;
}

/**
 * Which item a paste takes, from the event's text and the page's own
 * memory — 's contract, held as a pure function: readable text governs
 * (another tab or app may have put any text there, this page's own
 * earlier item included); the local copy pastes only when the event
 * carries no text and the last system write had failed. Whether that
 * local copy should also outrank the page's own EARLIER text after a
 * failed write is a design choice the contract does not make, and stays
 * open: the inputs are the same whether the earlier text is
 * stale or freshly copied elsewhere.
 */
export function pasteChoice(
  text: string,
  local: LocalCopy,
): ClipboardItem | null {
  if (text.trim() === "")
    return local.item && !local.systemWrote ? local.item : null;
  return readClipboardItem(text);
}
