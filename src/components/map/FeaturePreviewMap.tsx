"use client";

import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import { BASEMAP_FALLBACKS, resolveBasemapUrl } from "@/lib/basemap";
import { useTheme } from "@/components/theme";
import { attemptTablePreviewWebGLMap } from "./table-preview-webgl";
import styles from "./FeaturePreviewMap.module.css";
import attribution from "./maplibre-attribution.module.css";

/** The one ink a preview draws in — kelp, matching the accent. */
const PREVIEW_COLOR = "#0d7d5c";
const PREVIEW_COLOR_DARK = "#45c58f";

type Bounds = [[number, number], [number, number]];

/** Basemap unreachable: a plain background so the features still render. */
const emptyStyle = (color: string): maplibregl.StyleSpecification => ({
  version: 8,
  sources: {},
  layers: [{ id: "bg", type: "background", paint: { "background-color": color } }],
});

/** Walk a FeatureCollection for its lng/lat extent. */
export function featureBounds(geojson: unknown): Bounds | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const visit = (coords: unknown): void => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === "number" && typeof coords[1] === "number") {
      west = Math.min(west, coords[0]);
      east = Math.max(east, coords[0]);
      south = Math.min(south, coords[1]);
      north = Math.max(north, coords[1]);
      return;
    }
    for (const c of coords) visit(c);
  };
  const walk = (g: unknown): void => {
    if (!g || typeof g !== "object") return;
    const obj = g as {
      type?: string;
      coordinates?: unknown;
      geometry?: unknown;
      geometries?: unknown[];
      features?: unknown[];
    };
    if (obj.type === "FeatureCollection") obj.features?.forEach(walk);
    else if (obj.type === "Feature") walk(obj.geometry);
    else if (obj.type === "GeometryCollection") obj.geometries?.forEach(walk);
    else visit(obj.coordinates);
  };
  walk(geojson);
  if (!Number.isFinite(west) || !Number.isFinite(south)) return null;
  if (west === east && south === north) {
    // A single point: give fitBounds something to frame.
    return [
      [west - 0.01, south - 0.01],
      [east + 0.01, north + 0.01],
    ];
  }
  return [
    [west, south],
    [east, north],
  ];
}

export interface FeatureHover {
  x: number;
  y: number;
  properties: Record<string, unknown>;
}

/**
 * The feature preview primitive (extracted from the table preview map):
 * a MapLibre basemap following the theme, a GeoJSON collection drawn in
 * the one preview ink (polygons filled and outlined, lines stroked,
 * points as circles), fitted to its extent — refitted when the
 * collection changes — with the degrade-don't-break contract: a failing
 * basemap falls back to a plain background, and a missing WebGL context
 * is said out loud. Hosts own the frame and lay their notices and
 * readouts over it as children; `onHover` opts into a pointer readout
 * of the hovered feature's properties.
 */
export function FeaturePreviewMap({
  geojson,
  onHover,
  children,
}: {
  geojson: GeoJSON.GeoJSON | null;
  onHover?: (hover: FeatureHover | null) => void;
  children?: React.ReactNode;
}) {
  const { theme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  // The map whose style has loaded: assigned by that map's own style.load,
  // cleared when the map goes or a style swap begins, and read by the
  // features effect. A map remounted by a theme flip is not a loaded map
  // until its own style says so (the old map's loaded count let addSource
  // run on a style still being fetched, and the throw, out of an effect,
  // took the whole).
  const loadedMapRef = useRef<maplibregl.Map | null>(null);
  // The last extent fitted, refitted after a resize.
  const boundsRef = useRef<maplibregl.LngLatBoundsLike | null>(null);
  // The listener reads the latest hover callback without rebuilding the
  // map (the editor's `latest` idiom): assigned in an effect, never in render.
  const onHoverRef = useRef(onHover);
  useEffect(() => {
    onHoverRef.current = onHover;
  }, [onHover]);
  const [webglFailure, setWebglFailure] = useState<string | null>(null);
  // Bumped on every style.load — including the offline fallback swap — so
  // the features (re-)land whatever happens to the basemap.
  const [styleEpoch, setStyleEpoch] = useState(0);

  useEffect(() => {
    if (!containerRef.current) return;
    const attempted = attemptTablePreviewWebGLMap(
      containerRef.current,
      () =>
        new maplibregl.Map({
          container: containerRef.current!,
          style: resolveBasemapUrl(theme === "dark" ? "dark" : "light"),
          center: [10, 30],
          zoom: 1.2,
          attributionControl: { compact: true },
          dragRotate: false,
          pitchWithRotate: false,
        }),
    );
    if (!attempted.ok) {
      setWebglFailure(attempted.message);
      return;
    }
    const map = attempted.value;
    setWebglFailure(null);
    let removed = false;
    map.on("style.load", () => {
      if (removed) return;
      loadedMapRef.current = map;
      setStyleEpoch((n) => n + 1);
    });
    let failed = false;
    map.on("error", (e) => {
      const msg = String(e?.error?.message ?? "");
      if (!failed && /style|fetch|load|network/i.test(msg)) {
        failed = true;
        // Not loaded again until the fallback's own style.load says so.
        loadedMapRef.current = null;
        try {
          map.setStyle(
            emptyStyle(BASEMAP_FALLBACKS[theme === "dark" ? "dark" : "light"]),
          );
        } catch {
          /* Already swapped */
        }
      }
    });
    // Hover readout, when a host listens: the topmost feature under the
    // pointer across the three layers; leaving clears.
    const layers = ["table-circle", "table-fill", "table-line"];
    const onMove = (e: maplibregl.MapMouseEvent) => {
      if (!onHoverRef.current) return;
      const present = layers.filter((l) => map.getLayer(l));
      const hits = present.length
        ? map.queryRenderedFeatures(e.point, { layers: present })
        : [];
      if (!hits.length) {
        onHoverRef.current(null);
        return;
      }
      onHoverRef.current({
        x: e.point.x,
        y: e.point.y,
        properties: (hits[0].properties ?? {}) as Record<string, unknown>,
      });
    };
    map.on("mousemove", onMove);
    map.on("mouseout", () => onHoverRef.current?.(null));
    // The painted camera, on the host element: a journey reads the centre,
    // zoom and size back and projects its own expected coordinates through
    // them, never through the app's fit of the same features.
    const stamp = () => {
      const el = containerRef.current;
      if (!el) return;
      const c = map.getCenter();
      el.dataset.previewCamera = JSON.stringify({ lng: c.lng, lat: c.lat, zoom: map.getZoom(), width: el.clientWidth, height: el.clientHeight });
    };
    map.on("moveend", stamp);
    map.on("load", stamp);
    // The host may resize under the map (the results band's separator):
    // the canvas follows its container without a remount, and the features
    // are fitted again, since a resize alone keeps the camera and would
    // crop the extent.
    const sizing = new ResizeObserver(() => {
      map.resize();
      const bounds = boundsRef.current;
      if (bounds) map.fitBounds(bounds, { padding: 48, duration: 0, maxZoom: 13 });
    });
    sizing.observe(containerRef.current);
    return () => {
      removed = true;
      sizing.disconnect();
      loadedMapRef.current = null;
      map.remove();
    };
    // The basemap follows the theme by remount — cheap, and the preview
    // holds no user state worth preserving across a theme flip.
  }, [theme]);

  useEffect(() => {
    // Only a map whose own style has loaded takes the features; the epoch
    // is what brings the effect back once one has.
    const map = loadedMapRef.current;
    if (!map) return;
    const color = theme === "dark" ? PREVIEW_COLOR_DARK : PREVIEW_COLOR;
    const data: GeoJSON.GeoJSON = geojson ?? {
      type: "FeatureCollection",
      features: [],
    };
    const existing = map.getSource("table") as
      | maplibregl.GeoJSONSource
      | undefined;
    if (!existing) {
      map.addSource("table", { type: "geojson", data });
      map.addLayer({
        id: "table-fill",
        type: "fill",
        source: "table",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "fill-color": color, "fill-opacity": 0.18 },
      });
      map.addLayer({
        id: "table-line",
        type: "line",
        source: "table",
        filter: [
          "in",
          ["geometry-type"],
          ["literal", ["Polygon", "LineString"]],
        ],
        paint: { "line-color": color, "line-width": 1.6 },
      });
      map.addLayer({
        id: "table-circle",
        type: "circle",
        source: "table",
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-color": color,
          "circle-radius": 3.5,
          "circle-opacity": 0.85,
          "circle-stroke-color": theme === "dark" ? "#0b0e14" : "#ffffff",
          "circle-stroke-width": 1,
        },
      });
    } else {
      existing.setData(data);
    }
    const bounds = geojson ? featureBounds(geojson) : null;
    boundsRef.current = bounds;
    if (bounds) {
      map.fitBounds(bounds, { padding: 48, duration: 0, maxZoom: 13 });
    }
    // The host element counts the style loads the features have landed
    // on, so a journey can hold that a theme flip lands them again on the
    // remounted map's own load.
    if (containerRef.current) {
      containerRef.current.dataset.featuresLanded = String(styleEpoch);
    }
  }, [styleEpoch, geojson, theme]);

  return (
    <>
      <div
        ref={containerRef}
        className={`${styles.map} ${attribution.themed}`}
        data-preview-map=""
      />
      {webglFailure && (
        <div
          className={`${styles.notice} ${styles.webglFailure}`}
          role="alert"
          data-table-webgl-failed=""
        >
          <div>
            <strong>WebGL is unavailable</strong>
            <p>{webglFailure}</p>
          </div>
        </div>
      )}
      {children}
    </>
  );
}
