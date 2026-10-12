"use client";

import { useState } from "react";
import type { OperationDef } from "@/lib/operations/catalog";
import type { TableListing } from "../api";
import { AddToMapDialog, tableSubject } from "../AddToMapDialog";
import { ResultsBand } from "./ResultsBand";
import type { CanvasGraph, CanvasMember } from "./graph";
import type { WorkflowRunner } from "./use-workflow-run";
import { useTemplateCanvas } from "./template-canvas";

/**
 * The results band with its map door, beside the canvas host: the band
 * over the selection and the runs, and the Data page's *Add to a map*
 * dialog, keyed by its subject so every open binds the layer name
 * afresh, as the dialog's other hosts do. Never node state: the dialog
 * writes a map and its layer, nothing of the recipe.
 */
export function CanvasResults(props: Parameters<typeof Results>[0]) {
  // A template's workflow has no runs, and its data no one's listing: the
  // band has nothing to show there.
  return useTemplateCanvas() ? null : <Results {...props} />;
}

function Results({
  graph,
  selected,
  tables,
  operations,
  runner,
  hostHeight,
  onHeight,
  onSelectNode,
  onListingStale,
}: {
  graph: CanvasGraph;
  selected: CanvasMember | null;
  tables: TableListing[];
  operations: OperationDef[];
  runner: WorkflowRunner;
  hostHeight: number;
  onHeight: (px: number) => void;
  onSelectNode: (stepId: string) => void;
  /** A dataset the listing still held has vanished: the page re-reads it. */
  onListingStale: () => void;
}) {
  const [subject, setSubject] = useState<string | null>(null);
  return (
    <>
      <ResultsBand
        runs={runner.state.runs}
        activeRunId={runner.state.active?.id ?? null}
        hostHeight={hostHeight}
        selected={selected}
        tables={tables}
        operations={operations}
        nodeExists={(stepId) => graph.members.some((m) => m.id === stepId)}
        onSelectNode={onSelectNode}
        onHeight={onHeight}
        onAddToMap={setSubject}
        onListingStale={onListingStale}
      />
      {/* The closed key is no table name: a registered name never carries a bracket. */}
      <AddToMapDialog key={subject ?? "<closed>"} subject={tableSubject(subject)} onClose={() => setSubject(null)} />
    </>
  );
}
