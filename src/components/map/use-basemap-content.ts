"use client";

import { useCallback, useEffect, useRef } from "react";
import type * as maplibregl from "maplibre-gl";
import type { BasemapKind } from "@/lib/basemap";
import {
  authoredBasemapVisibility,
  basemapLayerVisibilities,
  presentBasemapGroups,
  type BasemapLayerGroup,
  type BasemapLayers,
  type BasemapLayerVisibility,
  type StyleLayerLike,
} from "@/lib/basemap-layers";
import { isFallbackStyle } from "./use-basemap-style";

/**
 * The basemap content-group lifecycle, extracted from the shared
 * canvas: remember each loaded style's authored visibilities, apply the
 * map's group toggles over them, re-apply on toggle/kind changes, and
 * report which groups the loaded style actually yields — the panel
 * marks the rest "not in this style" while a custom style is active.
 */
export function useBasemapContent(
  map: React.RefObject<maplibregl.Map | null>,
  basemapUrl: string,
  basemapLayers: BasemapLayers | null,
  basemapKind: BasemapKind,
  onBasemapGroups?: (groups: BasemapLayerGroup[] | null) => void,
): { attach: (instance: maplibregl.Map) => void } {
  // Authored visibilities of the current style, captured at style load —
  // before we touch them — so hidden groups re-apply over the style's own
  // truth: initial load, basemap change, theme switch, offline fallback
  // alike.
  const styleVisibility = useRef<Map<string, BasemapLayerVisibility>>(new Map());
  const basemapLayersRef = useRef<BasemapLayers | null>(basemapLayers);
  const basemapKindRef = useRef<BasemapKind>(basemapKind);
  const onGroupsRef = useRef(onBasemapGroups);
  useEffect(() => {
    onGroupsRef.current = onBasemapGroups;
  }, [onBasemapGroups]);

  // A style switch invalidates the previous report immediately: until
  // the new style loads, its groups are unknown — style A's groups must
  // never be presented as style B's.
  const reportedUrl = useRef(basemapUrl);
  useEffect(() => {
    if (reportedUrl.current === basemapUrl) return;
    reportedUrl.current = basemapUrl;
    onGroupsRef.current?.(null);
  }, [basemapUrl]);

  const applyBasemapLayers = useCallback(
    (instance: maplibregl.Map) => {
      // The decision is the shared rule: imagery yields nothing,
      // unrecognized content is never hidden, and this instance's own
      // authored record answers the rest.
      const decided = basemapLayerVisibilities({
        kind: basemapKindRef.current,
        layers: (instance.getStyle()?.layers ?? []) as StyleLayerLike[],
        toggles: basemapLayersRef.current,
        authored: (id) => styleVisibility.current.get(id),
      });
      for (const { id, visibility } of decided) {
        const current =
          (instance.getLayoutProperty(id, "visibility") as string | undefined) ??
          "visible";
        if (current !== visibility) {
          instance.setLayoutProperty(id, "visibility", visibility);
        }
      }
    },
    [],
  );

  // Re-apply group visibility when the toggles or the style kind change;
  // a style mid-load picks the refs up in its own style.load instead.
  useEffect(() => {
    basemapLayersRef.current = basemapLayers;
    basemapKindRef.current = basemapKind;
    if (map.current?.isStyleLoaded()) applyBasemapLayers(map.current);
  }, [map, basemapLayers, basemapKind, applyBasemapLayers]);

  const attach = useCallback(
    (instance: maplibregl.Map) => {
      instance.on("style.load", () => {
        styleVisibility.current = authoredBasemapVisibility(
          (instance.getStyle()?.layers ?? []) as {
            id: string;
            layout?: { visibility?: string };
          }[],
        );
        applyBasemapLayers(instance);
        // Report what this style actually yields — per load, so a style switch replaces the report,
        // never blends it. The offline fallback — identified by its explicit marker, not its shape
        // (a genuine one-background style must not read as the fallback) — is not a report: a
        // failed style's groups are unknown, not absent.
        const style = instance.getStyle();
        onGroupsRef.current?.(
          style && isFallbackStyle(style)
            ? null
            : presentBasemapGroups(
                (style?.layers ?? []) as StyleLayerLike[],
              ),
        );
      });
    },
    [applyBasemapLayers],
  );

  return { attach };
}
