"use client";

import * as maplibregl from "@/lib/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { builtInBasemapUrl } from "@/lib/basemap";
import { useTheme } from "@/components/theme";
import type { Bbox } from "@/lib/bbox";
import { ringBbox, type Ring } from "@/lib/overture/query";
import {
  geometryBbox,
  isPolygonalGeometry,
  type PolygonalGeometry,
} from "@/lib/geo-shape";
import {
  haversineKm,
  ringAreaKm2,
  formatDistanceKm,
  formatAreaKm2,
} from "@/lib/geo-measure";
import type { DataTable } from "./api";
import styles from "./MiniMap.module.css";
import attribution from "./map/maplibre-attribution.module.css";

export interface MiniViewport {
  lng: number;
  lat: number;
  zoom: number;
}

/** What the area tool currently selects: a rectangle or
 * view bbox, a drawn polygon ring, or a feature picked from a layer. Null
 * while nothing is finalized. */
export type DrawnShape =
  | { kind: "bbox"; bbox: Bbox }
  | { kind: "polygon"; ring: Ring; bbox: Bbox }
  | {
      kind: "feature";
      geometry: PolygonalGeometry;
      bbox: Bbox;
      source: string;
    };

/** View = whole visible map · rect = adjustable rectangle · draw =
 * click-to-draw with live preview · pick = select a polygon from a layer ·
 * idle = no area interaction (named scopes). "poly" is the name for
 * draw, kept for callers mid-migration. */
export type AreaMode = "view" | "rect" | "draw" | "poly" | "pick" | "idle";

interface Props {
  initialViewport?: MiniViewport | null;
  mode: AreaMode;
  onShape: (shape: DrawnShape | null) => void;
  /** Run Query results: a GeoJSON FeatureCollection drawn
   * as an overlay in every mode; null clears it. */
  preview?: unknown;
  /** Fit-to-selection: the map flies to this extent when
   * it changes; null leaves the view alone. */
  focus?: Bbox | null;
}

interface RectFractions {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const DEFAULT_RECT: RectFractions = { x0: 0.18, y0: 0.16, x1: 0.82, y1: 0.84 };
const MIN_SIZE = 0.08;
const EDGE = 0.02;
const MAX_POLY_POINTS = 500;

/** The Run Query overlay color — distinct from every reference layer. */
const PREVIEW_COLOR = "#e11d48";

/** Polygon-bearing candidates for the Data box — point/line-only tables
 * are noise for area selection. */
function polygonCandidate(t: DataTable): boolean {
  return (
    t.geometryColumn !== null &&
    t.geometryType !== null &&
    /POLYGON|MIXED|GEOMETRY/i.test(t.geometryType)
  );
}

function hasPolygons(data: TableFeaturesBody | undefined): boolean {
  if (!data?.ok || !data.geojson) return false;
  return data.geojson.features.some(
    (f) =>
      f.geometry?.type === "Polygon" || f.geometry?.type === "MultiPolygon",
  );
}

/** Distinct reference-layer colors, assigned by table order. */
const LAYER_COLORS = [
  "#2563eb",
  "#d97706",
  "#059669",
  "#db2777",
  "#7c3aed",
  "#0891b2",
  "#65a30d",
  "#dc2626",
];

interface TableFeaturesBody {
  ok: boolean;
  reason?: string;
  geojson?: {
    type: "FeatureCollection";
    features: {
      type: "Feature";
      id: number;
      geometry: { type: string; coordinates: unknown };
      properties: Record<string, unknown>;
    }[];
  };
}

interface Picked {
  geometry: PolygonalGeometry;
  bbox: Bbox;
  source: string;
  featureId: number;
}

const EYE = (
  <svg viewBox="0 0 24 24" aria-hidden>
    <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z" />
    <circle cx="12" cy="12" r="2.6" />
  </svg>
);

const EYE_OFF = (
  <svg viewBox="0 0 24 24" aria-hidden>
    <path d="M4 4l16 16M9.9 5.9A10.6 10.6 0 0 1 12 5.5c6.5 0 10 6.5 10 6.5a17.5 17.5 0 0 1-3.2 3.9M6.1 8.3A16.9 16.9 0 0 0 2 12s3.5 6.5 10 6.5c1.4 0 2.7-.3 3.8-.8" />
  </svg>
);

/**
 * The import dialog's map: area selection plus the workspace's tables as
 * toggleable reference layers. Draw mode previews the polygon live with
 * geodesic measurements; Enter or right-click finishes it; pick mode
 * turns an existing polygon feature into the selected area. Emits the
 * selection on every relevant change.
 */
export function MiniMap({
  initialViewport,
  mode,
  onShape,
  preview,
  focus,
}: Props) {
  const normalized = mode === "poly" ? "draw" : mode;
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [rect, setRect] = useState<RectFractions>(DEFAULT_RECT);
  const [poly, setPoly] = useState<Ring>([]);
  /** Draw mode: false while collecting points; true once finished. */
  const [finalized, setFinalized] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [ready, setReady] = useState(false);
  // Screen-space projections of the committed ring, refreshed on map moves.
  const [screenPoints, setScreenPoints] = useState<{ x: number; y: number }[]>(
    [],
  );
  /** The live cursor while drawing: screen px for the rubber band, lng/lat
   * for the provisional edge measurements. */
  const [cursor, setCursor] = useState<{
    x: number;
    y: number;
    lng: number;
    lat: number;
  } | null>(null);

  const [tables, setTables] = useState<DataTable[] | null>(null);
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [layerData, setLayerData] = useState<
    Record<string, TableFeaturesBody>
  >({});
  const { theme } = useTheme();

  const modeRef = useRef(normalized);
  const rectRef = useRef(rect);
  const polyRef = useRef(poly);
  const finalizedRef = useRef(finalized);
  const spaceRef = useRef(spaceHeld);
  const pickedRef = useRef(picked);
  const onShapeRef = useRef(onShape);
  const tablesRef = useRef(tables);
  const hiddenRef = useRef(hidden);
  const layerDataRef = useRef(layerData);
  const previewRef = useRef(preview);
  useEffect(() => {
    modeRef.current = normalized;
    rectRef.current = rect;
    polyRef.current = poly;
    finalizedRef.current = finalized;
    spaceRef.current = spaceHeld;
    pickedRef.current = picked;
    onShapeRef.current = onShape;
    tablesRef.current = tables;
    hiddenRef.current = hidden;
    layerDataRef.current = layerData;
    previewRef.current = preview;
  }, [
    normalized,
    rect,
    poly,
    finalized,
    spaceHeld,
    picked,
    onShape,
    tables,
    hidden,
    layerData,
    preview,
  ]);

  const emit = useCallback(() => {
    const map = mapRef.current;
    const container = containerRef.current;
    if (!map || !container) return;
    const m = modeRef.current;
    if (m === "idle") {
      onShapeRef.current(null);
      return;
    }
    if (m === "pick") {
      const p = pickedRef.current;
      onShapeRef.current(
        p
          ? {
              kind: "feature",
              geometry: p.geometry,
              bbox: p.bbox,
              source: p.source,
            }
          : null,
      );
      return;
    }
    if (m === "draw") {
      const ring = polyRef.current;
      onShapeRef.current(
        finalizedRef.current && ring.length >= 3
          ? { kind: "polygon", ring, bbox: ringBbox(ring) }
          : null,
      );
      return;
    }
    if (m === "view") {
      const b = map.getBounds();
      onShapeRef.current({
        kind: "bbox",
        bbox: [
          Math.max(-180, b.getWest()),
          Math.max(-90, b.getSouth()),
          Math.min(180, b.getEast()),
          Math.min(90, b.getNorth()),
        ],
      });
      return;
    }
    const { width, height } = container.getBoundingClientRect();
    const r = rectRef.current;
    const nw = map.unproject([r.x0 * width, r.y0 * height]);
    const se = map.unproject([r.x1 * width, r.y1 * height]);
    onShapeRef.current({
      kind: "bbox",
      bbox: [
        Math.max(-180, Math.min(nw.lng, se.lng)),
        Math.max(-90, Math.min(nw.lat, se.lat)),
        Math.min(180, Math.max(nw.lng, se.lng)),
        Math.min(90, Math.max(nw.lat, se.lat)),
      ],
    });
  }, []);

  const reproject = useCallback(() => {
    const map = mapRef.current;
    if (!map || modeRef.current !== "draw") {
      setScreenPoints((current) => (current.length === 0 ? current : []));
      return;
    }
    setScreenPoints(
      polyRef.current.map(([lng, lat]) => {
        const p = map.project([lng, lat]);
        return { x: p.x, y: p.y };
      }),
    );
  }, []);

  /** Add/refresh the reference layers and the pick highlight — idempotent,
   * safe to re-run after restyles. */
  const syncLayers = useCallback(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    (tablesRef.current ?? []).forEach((t, i) => {
      const id = `tbl-${t.name}`;
      const data = layerDataRef.current[t.name];
      // Reference layers exist only in pick mode — any other mode
      // removes them on the spot.
      const show =
        modeRef.current === "pick" &&
        hasPolygons(data) &&
        !hiddenRef.current[t.name];
      const existing = map.getSource(id) as maplibregl.GeoJSONSource | null;
      if (!show) {
        for (const suffix of ["fill", "line", "circle"]) {
          if (map.getLayer(`${id}-${suffix}`)) map.removeLayer(`${id}-${suffix}`);
        }
        if (existing) map.removeSource(id);
        return;
      }
      const color = LAYER_COLORS[i % LAYER_COLORS.length];
      if (!existing) {
        map.addSource(id, {
          type: "geojson",
          data: data!.geojson as unknown as GeoJSON.GeoJSON,
        });
      }
      if (!map.getLayer(`${id}-fill`)) {
        map.addLayer({
          id: `${id}-fill`,
          type: "fill",
          source: id,
          filter: ["==", ["geometry-type"], "Polygon"],
          paint: { "fill-color": color, "fill-opacity": 0.14 },
        });
        map.addLayer({
          id: `${id}-line`,
          type: "line",
          source: id,
          filter: [
            "in",
            ["geometry-type"],
            ["literal", ["Polygon", "LineString"]],
          ],
          paint: { "line-color": color, "line-width": 1.4 },
        });
        map.addLayer({
          id: `${id}-circle`,
          type: "circle",
          source: id,
          filter: ["==", ["geometry-type"], "Point"],
          paint: {
            "circle-color": color,
            "circle-radius": 3,
            "circle-opacity": 0.85,
          },
        });
      }
    });

    const sel = pickedRef.current;
    const selData: GeoJSON.GeoJSON = {
      type: "FeatureCollection",
      features:
        sel && modeRef.current === "pick"
          ? [
              {
                type: "Feature",
                geometry: sel.geometry as GeoJSON.Geometry,
                properties: {},
              },
            ]
          : [],
    };
    const selSource = map.getSource("pick-sel") as
      | maplibregl.GeoJSONSource
      | undefined;
    if (selSource) {
      selSource.setData(selData);
    } else {
      map.addSource("pick-sel", { type: "geojson", data: selData });
      map.addLayer({
        id: "pick-sel-fill",
        type: "fill",
        source: "pick-sel",
        paint: { "fill-color": "#0d9488", "fill-opacity": 0.22 },
      });
      map.addLayer({
        id: "pick-sel-line",
        type: "line",
        source: "pick-sel",
        paint: { "line-color": "#0d9488", "line-width": 2.5 },
      });
    }

    // Run Query results overlay — drawn in every mode.
    const previewData = (previewRef.current ?? {
      type: "FeatureCollection",
      features: [],
    }) as GeoJSON.GeoJSON;
    const previewSource = map.getSource("run-preview") as
      | maplibregl.GeoJSONSource
      | undefined;
    if (previewSource) {
      previewSource.setData(previewData);
    } else {
      map.addSource("run-preview", { type: "geojson", data: previewData });
      map.addLayer({
        id: "run-preview-fill",
        type: "fill",
        source: "run-preview",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "fill-color": PREVIEW_COLOR, "fill-opacity": 0.16 },
      });
      map.addLayer({
        id: "run-preview-line",
        type: "line",
        source: "run-preview",
        filter: [
          "in",
          ["geometry-type"],
          ["literal", ["Polygon", "LineString"]],
        ],
        paint: { "line-color": PREVIEW_COLOR, "line-width": 1.6 },
      });
      map.addLayer({
        id: "run-preview-circle",
        type: "circle",
        source: "run-preview",
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-color": PREVIEW_COLOR,
          "circle-radius": 3.5,
          "circle-opacity": 0.85,
        },
      });
    }
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: builtInBasemapUrl(theme === "dark" ? "dark" : "light"),
      center: initialViewport
        ? [initialViewport.lng, initialViewport.lat]
        : [10, 30],
      zoom: initialViewport?.zoom ?? 1.2,
      ...maplibregl.MAP_RENDERER_OPTIONS,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
    });
    map.doubleClickZoom.disable();
    mapRef.current = map;
    // The compact attribution starts expanded and only collapses on the
    // first interaction — start it collapsed; the ⓘ toggle keeps it
    // reachable.
    const collapseAttribution = () => {
      map
        .getContainer()
        .querySelectorAll(".maplibregl-ctrl-attrib")
        .forEach((el) => {
          el.classList.remove("maplibregl-compact-show");
          el.removeAttribute("open");
        });
    };
    collapseAttribution();
    map.on("load", () => {
      setReady(true);
      collapseAttribution();
      emit();
      syncLayers();
    });
    map.on("styledata", () => syncLayers());
    map.on("moveend", emit);
    map.on("move", () => reproject());
    map.on("mousemove", (e) => {
      if (modeRef.current !== "draw" || finalizedRef.current) return;
      setCursor({
        x: e.point.x,
        y: e.point.y,
        lng: e.lngLat.lng,
        lat: e.lngLat.lat,
      });
    });
    map.on("click", (e) => {
      const m = modeRef.current;
      if (m === "draw") {
        if (finalizedRef.current || spaceRef.current) return;
        if (polyRef.current.length >= MAX_POLY_POINTS) return;
        setPoly((current) => [...current, [e.lngLat.lng, e.lngLat.lat]]);
        return;
      }
      if (m !== "pick") return;
      const fillIds = (tablesRef.current ?? [])
        .map((t) => `tbl-${t.name}-fill`)
        .filter((id) => map.getLayer(id));
      if (fillIds.length === 0) return;
      const hits = map.queryRenderedFeatures(e.point, { layers: fillIds });
      for (const hit of hits) {
        const table = hit.source.replace(/^tbl-/, "");
        // Rendered features are tile-clipped; the true geometry comes from
        // the fetched collection by the feature's stable id.
        const original = layerDataRef.current[table]?.geojson?.features.find(
          (f) => f.id === hit.id,
        );
        if (!original || !isPolygonalGeometry(original.geometry)) continue;
        const geometry = original.geometry as PolygonalGeometry;
        setPicked({
          geometry,
          bbox: geometryBbox(geometry),
          source: table,
          featureId: original.id,
        });
        return;
      }
    });
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // The map is created once; theme changes restyle it below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    mapRef.current?.setStyle(
      builtInBasemapUrl(theme === "dark" ? "dark" : "light"),
    );
  }, [theme]);

  // The polygon-bearing tables — the Data box's contents. Loaded on the
  // first entry into pick mode; nothing loads in other modes (v2).
  useEffect(() => {
    if (normalized !== "pick" || tables !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/tables");
        if (!response.ok) return;
        const body = (await response.json()) as DataTable[];
        if (!cancelled) setTables(body.filter(polygonCandidate));
      } catch {
        /* The Data box simply stays empty */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [normalized, tables]);

  // Features load lazily for layers that are shown and not yet fetched.
  useEffect(() => {
    if (normalized !== "pick" || !tables) return;
    let cancelled = false;
    for (const t of tables) {
      if (hidden[t.name] || layerData[t.name]) continue;
      (async () => {
        try {
          const response = await fetch(
            `/api/tables/${encodeURIComponent(t.name)}/features`,
          );
          if (!response.ok) return;
          const body = (await response.json()) as TableFeaturesBody;
          if (!cancelled)
            setLayerData((current) =>
              current[t.name] ? current : { ...current, [t.name]: body },
            );
        } catch {
          /* Missing layers just don't draw */
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [normalized, tables, hidden, layerData]);

  // Mode, selection, or layer changes re-derive the shape and overlays.
  useEffect(() => {
    if (!ready) return;
    emit();
    reproject();
    syncLayers();
  }, [
    normalized,
    rect,
    poly,
    finalized,
    picked,
    tables,
    hidden,
    layerData,
    preview,
    ready,
    emit,
    reproject,
    syncLayers,
  ]);

  // Draw-mode keys: Enter finishes, Space pans, Escape deletes the
  // in-progress polygon. Capture-phase — the dialog's own
  // Escape-to-close listener must not fire while a draw is being
  // cancelled.
  useEffect(() => {
    if (normalized !== "draw") return;
    const down = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement) {
        const tag = e.target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      }
      if (e.code === "Space") {
        e.preventDefault();
        setSpaceHeld(true);
        return;
      }
      if (
        e.key === "Escape" &&
        !finalizedRef.current &&
        polyRef.current.length > 0
      ) {
        e.preventDefault();
        e.stopPropagation();
        setPoly([]);
        return;
      }
      if (
        e.key === "Enter" &&
        !finalizedRef.current &&
        polyRef.current.length >= 3
      ) {
        e.preventDefault();
        setFinalized(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceHeld(false);
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      setSpaceHeld(false);
    };
  }, [normalized]);

  // Fit-to-selection: fly to a newly chosen boundary's extent; user
  // panning afterwards is left alone until it changes again.
  const focusKey = focus ? focus.join(",") : "";
  useEffect(() => {
    if (!ready || !focusKey) return;
    const [w, s, e, n] = focusKey.split(",").map(Number);
    mapRef.current?.fitBounds(
      [
        [w, s],
        [e, n],
      ],
      { padding: 40, duration: 700, maxZoom: 12 },
    );
  }, [focusKey, ready]);

  // The cursor states the interaction: crosshair to draw, hand to pan,
  // pointer to pick.
  useEffect(() => {
    const canvas = mapRef.current?.getCanvas();
    if (!canvas) return;
    canvas.style.cursor =
      normalized === "draw" && !finalized
        ? spaceHeld
          ? "grab"
          : "crosshair"
        : normalized === "pick"
          ? "pointer"
          : "";
  }, [normalized, finalized, spaceHeld, ready]);

  // Gestures always release: window listeners come off on release, on
  // cancellation (touch takeover), on unmount — and when the gesture's
  // surface leaves the screen while the component stays mounted (review
  // round two): the picker can switch modes mid-drag via keyboard or a
  // second touch, removing the rect or the vertex circles without any
  // pointer event reaching their teardown. Keyed on the surfaces'
  // presence inputs, none of which a healthy in-gesture state update can
  // change. Applied state stays; only the tracking ends.
  const gestureTeardown = useRef<(() => void) | null>(null);
  const gestureSurface = `${normalized}:${finalized}:${poly.length > 0}`;
  useEffect(
    () => () => {
      gestureTeardown.current?.();
      gestureTeardown.current = null;
    },
    [gestureSurface],
  );

  const startDrag = useCallback(
    (corner: "nw" | "ne" | "sw" | "se") =>
      (e: React.PointerEvent<HTMLSpanElement>) => {
        e.preventDefault();
        e.stopPropagation();
        const container = containerRef.current;
        if (!container || gestureTeardown.current) return;
        const bounds = container.getBoundingClientRect();
        const target = e.currentTarget;
        target.setPointerCapture(e.pointerId);

        const onMove = (ev: PointerEvent) => {
          const fx = Math.min(
            1 - EDGE,
            Math.max(EDGE, (ev.clientX - bounds.left) / bounds.width),
          );
          const fy = Math.min(
            1 - EDGE,
            Math.max(EDGE, (ev.clientY - bounds.top) / bounds.height),
          );
          setRect((r) => {
            const next = { ...r };
            if (corner === "nw" || corner === "sw")
              next.x0 = Math.min(fx, r.x1 - MIN_SIZE);
            else next.x1 = Math.max(fx, r.x0 + MIN_SIZE);
            if (corner === "nw" || corner === "ne")
              next.y0 = Math.min(fy, r.y1 - MIN_SIZE);
            else next.y1 = Math.max(fy, r.y0 + MIN_SIZE);
            return next;
          });
        };
        const onEnd = () => {
          gestureTeardown.current?.();
          gestureTeardown.current = null;
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onEnd);
        window.addEventListener("pointercancel", onEnd);
        gestureTeardown.current = () => {
          try {
            target.releasePointerCapture(e.pointerId);
          } catch {
            // Capture already released (e.g. after pointercancel).
          }
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onEnd);
          window.removeEventListener("pointercancel", onEnd);
        };
      },
    [],
  );

  const startVertexDrag = useCallback(
    (index: number) => (e: React.PointerEvent<SVGCircleElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const container = containerRef.current;
      const map = mapRef.current;
      if (!container || !map) return;
      if (gestureTeardown.current) return;
      const bounds = container.getBoundingClientRect();
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);

      const onMove = (ev: PointerEvent) => {
        const point = map.unproject([
          ev.clientX - bounds.left,
          ev.clientY - bounds.top,
        ]);
        setPoly((current) =>
          current.map((p, i) =>
            i === index
              ? [
                  Math.max(-180, Math.min(180, point.lng)),
                  Math.max(-90, Math.min(90, point.lat)),
                ]
              : p,
          ),
        );
      };
      const onEnd = () => {
        gestureTeardown.current?.();
        gestureTeardown.current = null;
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onEnd);
      window.addEventListener("pointercancel", onEnd);
      gestureTeardown.current = () => {
        try {
          target.releasePointerCapture(e.pointerId);
        } catch {
          // Capture already released (e.g. after pointercancel).
        }
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onEnd);
        window.removeEventListener("pointercancel", onEnd);
      };
    },
    [],
  );

  const removeVertex = useCallback((index: number) => {
    const remaining = polyRef.current.length - 1;
    setPoly((current) => current.filter((_, i) => i !== index));
    if (remaining < 3) setFinalized(false);
  }, []);

  const clearPoly = useCallback(() => {
    setPoly([]);
    setFinalized(false);
  }, []);

  const finishPoly = useCallback(() => {
    if (polyRef.current.length >= 3) setFinalized(true);
  }, []);

  const drawing = normalized === "draw" && !finalized;
  const projected = normalized === "draw" ? screenPoints : [];
  // The rubber band: committed points plus the live cursor while drawing.
  const bandPoints =
    drawing && cursor && projected.length > 0
      ? [...projected, { x: cursor.x, y: cursor.y }]
      : projected;
  const bandRing: Ring =
    drawing && cursor && poly.length > 0
      ? [...poly, [cursor.lng, cursor.lat]]
      : poly;

  const edgeLabels =
    normalized === "draw" && bandPoints.length >= 2
      ? bandPoints
          .map((p, i) => {
            const j = (i + 1) % bandPoints.length;
            // The closing edge only exists once the shape is a polygon.
            if (j === 0 && bandPoints.length < 3) return null;
            const a = bandRing[i];
            const b = bandRing[j];
            if (!a || !b) return null;
            const km = haversineKm(a, b);
            if (km <= 0) return null;
            return {
              key: i,
              x: (p.x + bandPoints[j].x) / 2,
              y: (p.y + bandPoints[j].y) / 2,
              text: formatDistanceKm(km),
            };
          })
          .filter((l): l is NonNullable<typeof l> => l !== null)
      : [];

  const areaBadge =
    normalized === "draw" && bandPoints.length >= 3
      ? {
          x: bandPoints.reduce((s, p) => s + p.x, 0) / bandPoints.length,
          y: bandPoints.reduce((s, p) => s + p.y, 0) / bandPoints.length,
          text: formatAreaKm2(ringAreaKm2(bandRing)),
        }
      : null;

  const hint =
    normalized === "idle"
      ? null
      : normalized === "view"
        ? "Importing everything in the current view"
        : normalized === "rect"
          ? "Drag the corners; pan and zoom the map to reposition"
          : normalized === "pick"
            ? picked
              ? `Selected a polygon from ${picked.source}. Click another to change`
              : "Click a polygon on the map to use it as the query area"
            : drawing
              ? poly.length < 3
                ? poly.length === 0
                  ? "Click to add points · hold Space to pan"
                  : "Click to add points · Esc starts over · Space pans"
                : "Enter or right-click to finish · Esc starts over"
              : "Drag corners to adjust · double-click one to remove";

  return (
    <div
      className={styles.wrap}
      onContextMenu={(e) => {
        if (modeRef.current !== "draw") return;
        e.preventDefault();
        if (!finalizedRef.current) finishPoly();
      }}
    >
      <div ref={containerRef} className={`${styles.map} ${attribution.themed}`} />
      {mode === "rect" && (
        <div
          className={styles.rect}
          style={{
            left: `${rect.x0 * 100}%`,
            top: `${rect.y0 * 100}%`,
            right: `${(1 - rect.x1) * 100}%`,
            bottom: `${(1 - rect.y1) * 100}%`,
          }}
          aria-hidden
        >
          <span className={styles.handle} data-corner="nw" onPointerDown={startDrag("nw")} />
          <span className={styles.handle} data-corner="ne" onPointerDown={startDrag("ne")} />
          <span className={styles.handle} data-corner="sw" onPointerDown={startDrag("sw")} />
          <span className={styles.handle} data-corner="se" onPointerDown={startDrag("se")} />
        </div>
      )}
      {normalized === "draw" && (
        <>
          <svg className={styles.polySvg} aria-hidden>
            {bandPoints.length >= 3 ? (
              <polygon
                className={styles.polyShape}
                points={bandPoints.map((p) => `${p.x},${p.y}`).join(" ")}
              />
            ) : (
              bandPoints.length === 2 && (
                <line
                  className={styles.polyLine}
                  x1={bandPoints[0].x}
                  y1={bandPoints[0].y}
                  x2={bandPoints[1].x}
                  y2={bandPoints[1].y}
                />
              )
            )}
            {projected.map((p, i) => (
              <circle
                key={i}
                className={styles.polyVertex}
                cx={p.x}
                cy={p.y}
                r={6}
                onPointerDown={finalized ? startVertexDrag(i) : undefined}
                onDoubleClick={(e) => {
                  if (!finalized) return;
                  e.stopPropagation();
                  removeVertex(i);
                }}
              />
            ))}
          </svg>
          {edgeLabels.map((l) => (
            <span
              key={l.key}
              className={styles.measure}
              style={{ left: l.x, top: l.y }}
            >
              {l.text}
            </span>
          ))}
          {areaBadge && (
            <span
              className={`${styles.measure} ${styles.areaBadge}`}
              style={{ left: areaBadge.x, top: areaBadge.y }}
            >
              {areaBadge.text}
            </span>
          )}
          {poly.length > 0 && (
            <div className={styles.polyActions}>
              {drawing && poly.length >= 3 && (
                <button type="button" onClick={finishPoly}>
                  Finish (Enter)
                </button>
              )}
              <button type="button" onClick={clearPoly}>
                Clear
              </button>
            </div>
          )}
        </>
      )}
      {normalized === "pick" && tables !== null && tables.length > 0 && (
        <div className={styles.legend} aria-label="Data">
          <b>Data</b>
          {tables.map((t, i) => {
            const data = layerData[t.name];
            const unavailable = data !== undefined && !data.ok;
            // Loaded but polygon-free: noise for area selection — drop it.
            if (data?.ok && !hasPolygons(data)) return null;
            return (
              <div
                key={t.name}
                className={styles.legendRow}
                data-off={hidden[t.name] || unavailable || undefined}
                data-hint={unavailable ? data.reason : undefined}
                data-hint-always={unavailable ? "" : undefined}
              >
                <i
                  style={{
                    background: LAYER_COLORS[i % LAYER_COLORS.length],
                  }}
                />
                <span>{t.name}</span>
                <button
                  type="button"
                  aria-label={
                    hidden[t.name] ? `Show ${t.name}` : `Hide ${t.name}`
                  }
                  disabled={unavailable}
                  onClick={() =>
                    setHidden((current) => ({
                      ...current,
                      [t.name]: !current[t.name],
                    }))
                  }
                >
                  {hidden[t.name] || unavailable ? EYE_OFF : EYE}
                </button>
              </div>
            );
          })}
        </div>
      )}
      {hint && <div className={styles.hint}>{hint}</div>}
    </div>
  );
}

export default MiniMap;
