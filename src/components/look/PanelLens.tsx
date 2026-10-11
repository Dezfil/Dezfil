"use client";

import { useEffect } from "react";
import { watchPanelLens } from "./panel-lens";

/** The bend of the liquid panels, kept in step with the person's look for
 * as long as the workspace document lives. It draws nothing itself. */
export function PanelLens() {
  useEffect(() => watchPanelLens(document), []);
  return null;
}
