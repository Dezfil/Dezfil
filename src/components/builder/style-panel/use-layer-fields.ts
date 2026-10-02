"use client";

import { useContext, useEffect, useState } from "react";
import type { Layer } from "@/lib/metadata/maps";
import type { LayerFieldsResult } from "@/lib/layer-service";
import { DocumentEditorContext } from "../../document-editor-context";

/** Field choices describe the saved query, so an optimistic query change
 * must settle before its fields can be read or offered to another edit. */
export function useLayerFields(layer: Layer): LayerFieldsResult | null {
  const sequence = useContext(DocumentEditorContext)?.sequence;
  const key = JSON.stringify([layer.id, layer.sql, layer.viz.type]);
  const [read, setRead] = useState<{ key: string; fields: LayerFieldsResult } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await sequence?.idle();
      if (cancelled || sequence?.stale || sequence?.disposed) return;
      try {
        const response = await fetch(`/api/layers/${layer.id}/fields`);
        if (!response.ok) return;
        const fields = await response.json() as LayerFieldsResult;
        if (!cancelled && !sequence?.stale && !sequence?.disposed) setRead({ key, fields });
      } catch {
        // Keep choices unavailable when their schema cannot be read.
      }
    })();
    return () => { cancelled = true; };
  }, [key, layer.id, sequence]);
  return read?.key === key ? read.fields : null;
}
