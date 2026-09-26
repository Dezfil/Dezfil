"use client";

import type { OperationDef } from "@/lib/operations/catalog";
import type { TableListing } from "../api";
import type { CanvasHelperLayout } from "./assistant-layout";
import { lastObservedRun, workflowAssistantContext, workflowFacts } from "./assistant-context";
import type { CanvasGraph, CanvasMember, NodeMember, SourceMember } from "./graph";
import { NodePanel } from "./NodePanel";
import type { WorkflowRun } from "./run-overlay";
import { SourcePanel } from "./SourcePanel";
import { WorkflowAssistantPane, type WorkflowAssistant } from "./WorkflowAssistantHost";

/**
 * The canvas's right-side furniture, out of `WorkflowCanvas.tsx` (the
 * decomposition rule at the touch): the selected member's panel, node
 * or source, with what the assistant pane does to it (item 7): hidden
 * while the pane replaces it below the limit, its state kept since it
 * stays mounted; shifted left by the pane's width plus gutter in full
 * view at or above the limit; and the pane itself, whose context and
 * chips read the selection and the runner. The band's reserve and the
 * free rect the placements read live here too.
 */

/** The gutter the shell keeps around its cards (the kit's token, as a number). */
export const GUTTER_PX = 14;

/** What the band's column keeps at the screen's foot in full view. */
export function bandReserve(view: "full" | "framed", bandHeight: number): number {
  return view === "full" ? bandHeight + GUTTER_PX : 0;
}

/** The screen rect of the canvas the pane, a panel, the band and an open
 * assistant pane do not cover: where a member is placed and a note
 * made. Measured off the flow area, the whole screen in full view and
 * the canvas card in framed, keeping the header's strip and the band's
 * column clear where they overlap it. A hidden panel has no rect and
 * takes nothing; an open assistant pane over the area takes its side.
 * */
export function freeRectOf(hostEl: HTMLElement) {
  const area = hostEl.querySelector("[data-flow-area]")?.getBoundingClientRect() ?? hostEl.getBoundingClientRect();
  const pane = hostEl.querySelector("[data-canvas-pane]")?.getBoundingClientRect();
  const panelEl = hostEl.querySelector<HTMLElement>("[data-node-panel], [data-source-panel]");
  const panel = panelEl && !panelEl.hidden ? panelEl.getBoundingClientRect() : undefined;
  const band = hostEl.querySelector("[data-results-band]")?.getBoundingClientRect();
  const assistant = document.querySelector('[data-assistant-pane][data-open="true"]')?.getBoundingClientRect();
  const left = pane ? Math.max(area.left, pane.right + GUTTER_PX) : area.left;
  let right = panel && panel.width > 0 ? Math.min(area.right, panel.left - GUTTER_PX) : area.right;
  if (assistant && assistant.left < area.right && assistant.top < area.bottom) right = Math.min(right, assistant.left - GUTTER_PX);
  const top = Math.max(area.top, 62);
  const bottom = band && band.top < area.bottom ? band.top : area.bottom;
  return { left, top, right, bottom };
}

export function CanvasFurniture({ selected, graph, operations, tables, layout, lockReason, onClose, onRemove, onSelect, onRemoveSource, assistant, recipe, runner }: {
  selected: CanvasMember | null;
  graph: CanvasGraph;
  operations: OperationDef[];
  tables: TableListing[];
  /** What the open pane does to the panel. */
  layout: CanvasHelperLayout;
  lockReason: string | null;
  onClose: () => void;
  onRemove: (member: NodeMember) => void;
  onSelect: (stepId: string) => void;
  onRemoveSource: (member: SourceMember) => void;
  assistant: WorkflowAssistant;
  recipe: { id: string; name: string };
  runner: { active: WorkflowRun | null; ended: WorkflowRun | null };
}) {
  const run = lastObservedRun(runner);
  const panel = selected && (selected.kind === "node" || selected.kind === "source") ? selected : null;
  const style = { "--panel-shift": `${layout.panelShift}px` } as React.CSSProperties;
  return (
    <>
      {panel && (
        <div hidden={layout.panelHidden} style={style} data-canvas-furniture data-panel-shift={layout.panelShift || undefined}>
          {panel.kind === "node" ? (
            <NodePanel key={panel.id} member={panel} graph={graph} operations={operations} tables={tables} onClose={onClose} onRemove={onRemove} lockReason={lockReason} />
          ) : (
            <SourcePanel key={panel.id} member={panel} graph={graph} onSelect={onSelect} onClose={onClose} onRemove={onRemoveSource} lockReason={lockReason} />
          )}
        </div>
      )}
      <WorkflowAssistantPane
        assistant={assistant}
        overlay={layout.paneOverlay}
        context={workflowAssistantContext(recipe.id, selected, run)}
        facts={workflowFacts(recipe.name, selected, run)}
      />
    </>
  );
}
