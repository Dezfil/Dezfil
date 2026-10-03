"use client";

import { useContext, useEffect, useState } from "react";
import type { Layer } from "@/lib/metadata/maps";
import type { LayerFieldsResult } from "@/lib/layer-service";
import { DocumentEditorContext } from "../../document-editor-context";

/** Field choices describe the saved query, so an optimistic query change
 * must settle before its fields can be read or offered to another edit. */
export function useLayerFields(layer: Layer): LayerFieldsResult | null {
  const editor = useContext(DocumentEditorContext);
  const sequence = editor?.sequence;
  // A global queue barrier cannot identify which write produced this layer.
  // Keep the read tied to accepted state, including a return to a cached type.
  const accepted = editor?.settledLayer ? editor.settledLayer(layer.id) : layer;
  const key = JSON.stringify([layer.id, layer.sql, layer.viz.type]);
  const ready = accepted !== null && accepted.sql === layer.sql && accepted.viz.type === layer.viz.type
    && !sequence?.stale && !sequence?.disposed;
  const [read, setRead] = useState<{ key: string; accepted: Layer; fields: LayerFieldsResult } | null>(null);
  useEffect(() => {
    if (!ready || !accepted) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/layers/${layer.id}/fields`);
        if (!response.ok) return;
        const fields = await response.json() as LayerFieldsResult;
        if (!cancelled && !sequence?.stale && !sequence?.disposed) setRead({ key, accepted, fields });
      } catch {
        // Keep choices unavailable when their schema cannot be read.
      }
    })();
    return () => { cancelled = true; };
  }, [key, layer.id, accepted, ready, sequence]);
  return ready && read?.key === key && read.accepted === accepted ? read.fields : null;
}
