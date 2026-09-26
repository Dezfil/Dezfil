"use client";

import { createContext, useContext } from "react";
import type { RecipeEdits } from "./use-recipe-edits";

/** The recipe-edit coordinator, reachable from the panels and the pane
 * without threading it through every layer. */
export const EditsContext = createContext<RecipeEdits | null>(null);

export function useEdits(): RecipeEdits {
  const edits = useContext(EditsContext);
  if (!edits) throw new Error("The recipe-edit coordinator is not provided.");
  return edits;
}
