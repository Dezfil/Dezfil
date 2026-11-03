"use client";

import { useContext, useState } from "react";
import type { Layer } from "@/lib/metadata/maps";
import { isAggregated, type LayerViz } from "@/lib/viz";
import { DocumentEditorContext } from "../../document-editor-context";

/** What a field's values come from: the SQL, the filters and, on cells,
 * the aggregation; not the paint drawn over them. */
export function distributionSource(sql: string, filters: unknown, viz: LayerViz): string {
  const cells = isAggregated(viz) ? [viz.type, viz.cellKm, viz.aggregate] : null;
  return JSON.stringify([sql, filters, cells]);
}

const sourceOf = (layer: Layer) => distributionSource(layer.sql, layer.filters, layer.viz);

/**
 * The source of the values a layer shows, and whether the server holds it
 * yet. An edit to the SQL, the filters or the aggregation shows at once
 * but saves later, and a statistics read asked in between would answer
 * for the values before it; a paint edit leaves the source as the server
 * holds it, so a read already answered stays good through its save.
 */
export function useStatsSource(layer: Layer): { source: string; settled: boolean } {
  const editor = useContext(DocumentEditorContext);
  const source = sourceOf(layer);
  // The accepted layer is unavailable while the layer has edits in flight;
  // the source it last held stands until it is available again.
  const accepted = editor?.settledLayer ? editor.settledLayer(layer.id) : layer;
  const acceptedSource = accepted ? sourceOf(accepted) : null;
  const [held, setHeld] = useState(acceptedSource);
  if (acceptedSource !== null && acceptedSource !== held) setHeld(acceptedSource);
  return { source, settled: (acceptedSource ?? held) === source };
}
