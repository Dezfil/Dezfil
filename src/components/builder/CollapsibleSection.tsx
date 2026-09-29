"use client";

import { useReducer, type ReactNode } from "react";
import { ChevronIcon } from "../ui/icons";
import panel from "./panel.module.css";
import { onPrivateReset } from "../auth/private-state";

/** Collapsed sections per layer — module scope so the choice
 * survives the panel unmounting when a layer is deselected, and dies with
 * the page: a reload starts all-expanded again. */
const collapsedByLayer = new Map<string, Set<string>>();
onPrivateReset(() => collapsedByLayer.clear());

/**
 * One foldable section of the layer panel: the shared uppercase header
 * becomes the toggle, a chevron shows the state, and everything starts
 * expanded.
 */
export function CollapsibleSection({
  layerId,
  name,
  label,
  children,
}: {
  layerId: string;
  /** Stable key for the session memory, e.g. "fill". */
  name: string;
  label: ReactNode;
  children: ReactNode;
}) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const open = !collapsedByLayer.get(layerId)?.has(name);
  const toggle = () => {
    let set = collapsedByLayer.get(layerId);
    if (!set) collapsedByLayer.set(layerId, (set = new Set()));
    if (open) set.add(name);
    else set.delete(name);
    rerender();
  };
  return (
    <section className={panel.section}>
      <button
        type="button"
        className={panel.sectionHead}
        aria-expanded={open}
        onClick={toggle}
      >
        <span className={panel.sectionLabel}>{label}</span>
        <span className={panel.sectionChevron} data-open={open}>
          <ChevronIcon />
        </span>
      </button>
      {open && children}
    </section>
  );
}
