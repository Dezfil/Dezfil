"use client";

import { useCallback, useState } from "react";
import { useOpeningDefaults, type ScreenDefaults } from "../screen-defaults";
import { readMinimapChoice, writeMinimapChoice, type MinimapChoice } from "./minimap-store";
import { MINIMAP_AT } from "./view";

/**
 * How a workflow canvas opens, out of `WorkflowCanvas.tsx` under the
 * decomposition rule: full screen or framed, and whether the minimap
 * shows, from the instance's defaults as the page handed them down. They
 * are taken once, as the canvas opens, so a default changed meanwhile
 * applies at the next opening and an open canvas stays as it was.
 */

export type CanvasView = "full" | "framed";

/** Whether the minimap shows. The viewer's own choice by the stage button
 * holds in every workflow of this browser (never the server's) and always
 * wins; until they chose, the instance's rule decides, and its automatic
 * is the canvas's own rule, from six members. */
export function minimapShown(
  choice: MinimapChoice | null,
  rule: ScreenDefaults["canvas.minimap"],
  members: number,
): boolean {
  if (choice) return choice === "shown";
  return rule === "always" || (rule === "auto" && members >= MINIMAP_AT);
}

export function useCanvasOpening(members: number) {
  const opening = useOpeningDefaults();
  const [view, setView] = useState<CanvasView>(opening["canvas.opens"]);
  const [choice, setChoice] = useState(readMinimapChoice);
  const shown = minimapShown(choice, opening["canvas.minimap"], members);
  // The button always toggles what is on the screen, so a press while the
  // rule hides the map shows it rather than recording a choice nothing
  // displays.
  const toggleMinimap = useCallback(() => {
    const next = shown ? "hidden" : "shown";
    writeMinimapChoice(next);
    setChoice(next);
  }, [shown]);
  return { view, setView, minimapShown: shown, toggleMinimap };
}
