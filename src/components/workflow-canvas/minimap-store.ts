import { privateStateOpen } from "../auth/private-state";

/**
 * Whether the viewer wants the minimap (word after, -08-29: "an option to
 * hide and unhide it"): kept in the browser's storage, never on the
 * server. Until a viewer ever chose, the canvas follows spec rule and
 * shows the map from six members; a choice holds in every workflow:
 * "shown" draws it whatever the count, "hidden" never. The first cut kept
 * only "hidden", so on a small workflow the button's Show showed nothing
 * so the stack's new button did nothing.
 */

const KEY = "dezfil.workflow.minimap";

export type MinimapChoice = "shown" | "hidden";

export function readMinimapChoice(): MinimapChoice | null {
  if (!privateStateOpen()) return null;
  try {
    const raw = localStorage.getItem(KEY);
    return raw === "shown" || raw === "hidden" ? raw : null;
  } catch {
    return null;
  }
}

export function writeMinimapChoice(choice: MinimapChoice): void {
  if (!privateStateOpen()) return;
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    // Storage unavailable: the choice just will not be remembered.
  }
}
