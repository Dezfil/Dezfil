"use client";

import { createContext, useContext, useSyncExternalStore } from "react";
import { lookChoices } from "@/lib/look";

/**
 * The person's Side menu pick, as the rail lives it. The workspace document
 * is served with the pick on its root (`data-look-rail`, absent for today's
 * Opens on hover) and the Appearance tab restamps it; the attribute is the
 * store, observed the way the theme provider observes `data-theme`.
 *
 *   hover  a resting pointer or keyboard focus opens the rail over the page
 *   open   the rail stands open beside the page, which moves right with it
 *   icons  the rail never opens; each item names itself in a hint
 */
export type RailMode = "hover" | "open" | "icons";

/** A root attribute's value as a mode: anything this version does not offer
 * is today's behavior. */
export function railModeOf(value: string | null | undefined): RailMode {
  return value !== null && value !== undefined && lookChoices("rail").includes(value) ? (value as RailMode) : "hover";
}

function readRailMode(): RailMode {
  return railModeOf(document.documentElement.dataset.lookRail);
}

function subscribeRailMode(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-look-rail"] });
  return () => observer.disconnect();
}

/** The pick on the document's root. The server snapshot is today's behavior:
 * what the rail looks like before hydration is the stylesheet's, keyed on
 * the same attribute. */
export function useRailMode(): RailMode {
  return useSyncExternalStore(subscribeRailMode, readRailMode, () => "hover" as RailMode);
}

/** The rail hands its pick to its items, which carry a hint only under Icons only. */
export const RailModeContext = createContext<RailMode>("hover");

export function useRailItemMode(): RailMode {
  return useContext(RailModeContext);
}

/** Under Icons only the rail never opens, so an item names itself in the
 * hint beside its icon, shown although its label is in the markup: the
 * label is never on screen. */
export function railHint(mode: RailMode, name: string): { "data-hint"?: string; "data-hint-always"?: "" } {
  return mode === "icons" ? { "data-hint": name, "data-hint-always": "" } : {};
}

/** What the always-open rail adds to every left edge beside it, in pixels:
 * the root's `--rail-shift`, zero under the other picks and before the
 * browser has computed anything. Read from computed style, as the stage's
 * edge is, for the geometry that script lays out. */
export function readRailShift(): number {
  if (typeof window === "undefined" || typeof window.getComputedStyle !== "function") return 0;
  const value = Number.parseFloat(window.getComputedStyle(document.documentElement).getPropertyValue("--rail-shift"));
  return Number.isFinite(value) ? value : 0;
}
