"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import type { MapWithLayers } from "@/lib/metadata/maps";
import type { Bounds } from "@/lib/geo-bounds";
import type { AttributionLine, BasemapStyle } from "@/lib/basemap";
import { useTheme } from "@/components/theme";
import { readApiError } from "../api";
import { serverUnreachable } from "../failure-copy";
import { contributePath, releasePath } from "../shell/path-model";
import { PlainCrumbTail } from "../shell/PlainCrumbTail";
import { StageButton, StageStack } from "../map/StageStack";
import type { CameraHandle } from "../map/camera-handle";
import { ErrorNote } from "../ui/ErrorNote";
import { FitIcon } from "../ui/icons";
import { BuilderLoadFailure, BuilderLoading } from "../builder/BuilderFallback";
import { builderBasemap } from "../builder/builder-basemap";
import { layerFailureCopy } from "../builder/layer-failure";
import { MapPresentation } from "../builder/MapPresentation";
import { fetchLayerRender, renderBounds, type LayerRenderData } from "../builder/render-data";
import { useStageEdges } from "../builder/use-stage-edge";
import { mapWidgetEndpoints, useMapPresentation } from "../builder/use-map-presentation";
import { useTimeline } from "../builder/use-timeline";
import type { PersonLabel } from "../sharing/people";
import styles from "./MapReader.module.css";

/**
 * A Viewer's map: the builder's own presentation of it (the map, its legend
 * and widgets, the docked timeline) inside the workspace shell, with zoom,
 * north and fit, and nothing that edits. The header names the map, so the
 * published viewer's title bar and credit are left out.
 *
 * Read-only by construction rather than by checks: the page chooses this
 * component from the reader's standing on the server, and nothing here can
 * write. Its reads are the map and its layers' renders; the presentation is
 * handed no authoring part, so the camera, a thumbnail, the legend, the
 * widgets and the timeline are never persisted from here; there are no
 * editing shortcuts to press and no lock to undo.
 */

export interface ReaderData {
  map: MapWithLayers;
  /** The project the map is filed in, when the reader reaches it. */
  projectId: string | null;
  renders: Record<string, LayerRenderData>;
}

/** The map and every layer's render, reads only. A layer's failed render
 * is that layer's state, never the page's. */
export async function loadReader(
  mapId: string,
  fetcher: typeof fetch = fetch,
): Promise<ReaderData> {
  let response: Response;
  try {
    response = await fetcher(`/api/maps/${mapId}`);
  } catch {
    throw new Error(serverUnreachable("load the map"));
  }
  if (!response.ok) throw new Error(await readApiError(response));
  const map = (await response.json()) as MapWithLayers & { projectId?: string | null };
  const entries = await Promise.all(
    map.layers.map(async (l) => [l.id, await fetchLayerRender(l.id, fetcher)] as const),
  );
  return { map, projectId: map.projectId ?? null, renders: Object.fromEntries(entries) };
}

interface BasemapProps {
  basemapUrl: string;
  basemapOverrideUrl: string | null;
  basemapOverrideAttribution: AttributionLine[];
  basemaps: BasemapStyle[];
}

type ReaderState =
  | { status: "pending" }
  | { status: "failed"; message: string }
  | { status: "ready"; data: ReaderData };

export function MapReader({ mapId, ...basemap }: BasemapProps & { mapId: string }) {
  const [state, setState] = useState<ReaderState>({ status: "pending" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    loadReader(mapId).then(
      (data) => {
        if (!cancelled) setState({ status: "ready", data });
      },
      (e: unknown) => {
        if (!cancelled) {
          setState({ status: "failed", message: e instanceof Error ? e.message : "Failed to load map" });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [mapId, attempt]);

  if (state.status === "failed") {
    return (
      <BuilderLoadFailure
        message={state.message}
        onRetry={() => {
          setState({ status: "pending" });
          setAttempt((n) => n + 1);
        }}
      />
    );
  }
  if (state.status === "pending") return <BuilderLoading />;
  return (
    <ReaderStage
      mapId={mapId}
      map={state.data.map}
      projectId={state.data.projectId}
      renders={state.data.renders}
      {...basemap}
    />
  );
}

/** Writes the reader never makes: the timeline's settle, speed and dock
 * stay where the author left them. */
const keepStored = async () => false;
const keepLayer = async () => null;

export function ReaderStage({
  mapId,
  map,
  projectId,
  renders: loaded,
  basemapUrl,
  basemapOverrideUrl,
  basemapOverrideAttribution,
  basemaps,
}: BasemapProps & {
  mapId: string;
  map: MapWithLayers;
  projectId: string | null;
  renders: Record<string, LayerRenderData>;
}) {
  const { theme } = useTheme();
  const [renders, setRenders] = useState(loaded);
  const rendersRef = useRef(loaded);
  const mapRef = useRef<MapWithLayers | null>(map);
  const cameraRef = useRef<CameraHandle | null>(null);
  // The data frames the first view, as the builder's load does.
  const [fitBounds, setFitBounds] = useState<Bounds | null>(() => {
    const b = renderBounds(Object.values(loaded));
    return b ? ([...b] as Bounds) : null;
  });
  const [fitFailure, setFitFailure] = useState<string | null>(null);
  const fail = useCallback((_lane: "fit", message: string) => setFitFailure(message), []);
  const clearFailure = useCallback(() => setFitFailure(null), []);
  const endpoints = useMemo(() => mapWidgetEndpoints(mapId, null), [mapId]);
  const stage = useMapPresentation({
    map,
    renders,
    rendersRef,
    mapRef,
    endpoints,
    cameraRef,
    setFitBounds,
    fail,
    clearFailure,
    // The published viewer's calm: no status pill.
    statusPillHidden: true,
  });

  const refreshLayer = useCallback(async (layerId: string) => {
    const data = await fetchLayerRender(layerId);
    rendersRef.current = { ...rendersRef.current, [layerId]: data };
    setRenders((r) => ({ ...r, [layerId]: data }));
  }, []);
  // Tiles still preparing when the page loaded: poll until they settle.
  useEffect(() => {
    const preparing = Object.values(renders)
      .filter((r) => r.ok && r.tiles?.state === "building")
      .map((r) => r.layerId);
    if (preparing.length === 0) return;
    const timer = setTimeout(() => {
      for (const id of preparing) void refreshLayer(id);
    }, 2500);
    return () => clearTimeout(timer);
  }, [renders, refreshLayer]);

  // A docked timeline scrubs and plays for the reader; the window stays in
  // the browser, as on the published link.
  const timeline = useTimeline({
    map,
    patchMap: keepStored,
    patchLayer: keepLayer,
    refreshLayer,
    preview: stage.live.preview,
  });
  const bar = timeline.bar
    ? { ...timeline.bar, onSettle: () => true, onSpeed: undefined, onClose: undefined }
    : null;

  // No inspector: the stage starts where the builder's inspector would.
  // Set before the first paint, so the stage never shows at the builder's
  // edges first and slides across, and before the edges are read (the read
  // waits a frame).
  useLayoutEffect(() => {
    document.body.setAttribute("data-map-reader", "");
    return () => document.body.removeAttribute("data-map-reader");
  }, []);
  const stageEdges = useStageEdges();

  // The shell's path: the map's name and, when the reader reaches it, its
  // project, whose segment leads home and carries the people mark.
  const pathname = usePathname();
  useEffect(() => {
    contributePath(pathname, { name: map.name, projectId });
    return () => releasePath(pathname);
  }, [pathname, map.name, projectId]);

  const failed = map.layers.filter((l) => {
    const r = renders[l.id];
    return l.visible && r !== undefined && !r.ok;
  });
  const basemap = builderBasemap(map, {
    theme,
    basemapUrl,
    basemapOverrideUrl,
    basemapOverrideAttribution,
    basemaps,
  });

  return (
    <>
      <PlainCrumbTail name={map.name} owner={(map as { owner?: PersonLabel }).owner} />
      <MapPresentation
        stage={stage}
        map={map}
        basemap={basemap}
        theme={theme}
        stageEdges={stageEdges}
        fitBounds={fitBounds}
        timeline={bar}
        audience="reader"
        overlay={
          failed.length > 0 || fitFailure ? (
            <div className={styles.failures} data-reader-failures>
              {failed.map((l) => {
                const r = renders[l.id];
                const copy = layerFailureCopy(r && !r.ok ? (r.error ?? null) : null, "reader");
                return (
                  <ErrorNote
                    key={l.id}
                    message={`${l.name}: ${copy.message}`}
                    data-reader-layer-failed={l.id}
                  />
                );
              })}
              {fitFailure && (
                <ErrorNote message={fitFailure} onDismiss={() => setFitFailure(null)} />
              )}
            </div>
          ) : null
        }
        controls={
          <div className={styles.stack} data-reader-stack="top-right">
            <StageStack cameraRef={cameraRef} bearing={stage.bearing} pitch={stage.pitch}>
              <StageButton action="Fit to data" icon={<FitIcon />} onClick={stage.fitAll} />
            </StageStack>
          </div>
        }
      />
    </>
  );
}
