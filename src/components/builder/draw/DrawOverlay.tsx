"use client";

import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import type { CameraHandle } from "../../map/camera-handle";
import { formatDistanceKm, haversineKm } from "@/lib/geo-measure";
import {
  registerDraftCancel,
  useDrawMode,
  type DrawSelection,
} from "./draw-mode";
import type { SketchFeatureBody } from "./use-draw-session";
import type { SelectedSketchGeometry } from "./use-draw-integration";
import { circleRing, closeRing, rectangleRing } from "./draft-geometry";
import { POINT_MARK_PX, selectionMarkFor } from "./selection-mark";
import styles from "./draw.module.css";

/**
 * The draft overlay: an SVG over the stage that owns the pointer only while
 * a shape tool is armed — the map beneath never sees those gestures, which
 * is what keeps popups, cluster zoom and double-click zoom out of a drawing
 * — and that renders the in-progress draft, the circle's ground-metre
 * readout, the selected shape's mark (every kind, from its own geometry)
 * and the selected polygon's vertex handles. Ground positions are the
 * truth; screen positions are projected through the camera bridge and
 * reprojected on every camera frame. Visual reference:
 */

type Ground = [number, number];

interface VertexDraft {
  tool: "line" | "polygon";
  positions: Ground[];
}
interface DragDraft {
  tool: "rectangle" | "circle" | "freehand";
  start: Ground;
  current: Ground;
  path: Ground[];
}

/** Snap distance to a polygon's first vertex, in screen pixels. */
const SNAP_PX = 10;
/** Freehand sampling distance, in screen pixels. */
const SAMPLE_PX = 3;

export function DrawOverlay({
  camera,
  commit,
  selectedGeometry,
  onMoveVertex,
}: {
  camera: CameraHandle | null;
  commit: (feature: SketchFeatureBody) => Promise<void>;
  /** The selected feature's geometry, ground truth from the sketch
   * read, whatever its kind; null while nothing is selected. */
  selectedGeometry: SelectedSketchGeometry | null;
  onMoveVertex: (
    selection: DrawSelection,
    vertexIndex: number,
    position: Ground,
  ) => Promise<void>;
}) {
  const mode = useDrawMode();
  const svgRef = useRef<SVGSVGElement | null>(null);
  // The overlay's own client offset, held as state so projection during
  // render never touches a ref: measured on mount, on resize (the stage
  // edge animates size and position together), and re-checked per camera
  // frame, which also covers the drawer's slide.
  const [rect, setRect] = useState<{ left: number; top: number } | null>(
    null,
  );
  const [vertexDraft, setVertexDraft] = useState<VertexDraft | null>(null);
  const [dragDraft, setDragDraft] = useState<DragDraft | null>(null);
  const [cursor, setCursor] = useState<Ground | null>(null);
  const [draggingHandle, setDraggingHandle] = useState<{
    index: number;
    position: Ground;
  } | null>(null);
  const [, cameraTick] = useReducer((n: number) => n + 1, 0);

  const armedShape =
    mode.open &&
    mode.tool !== null &&
    mode.tool !== "hand" &&
    mode.tool !== "select";

  // Reproject on every camera frame — drafts and handles track the map.
  useEffect(() => {
    if (!camera) return;
    return camera.onCameraMove(() => {
      const el = svgRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        setRect((was) =>
          was && was.left === r.left && was.top === r.top
            ? was
            : { left: r.left, top: r.top },
        );
      }
      cameraTick();
    });
  }, [camera]);

  // Measured through a ref callback, not an effect keyed on mode: the
  // svg mounts and unmounts with what there is to draw, and a selection
  // on a page whose dock never opened must still measure — an effect
  // keyed on the dock left rect null there, and every projection
  // silently returned null (found by the browser round).
  const observerRef = useRef<ResizeObserver | null>(null);
  const measureRef = useCallback((el: SVGSVGElement | null) => {
    svgRef.current = el;
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setRect((was) =>
        was && was.left === r.left && was.top === r.top
          ? was
          : { left: r.left, top: r.top },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    observerRef.current = observer;
  }, []);

  // The Escape ladder's first rung: a draft consumes the
  // press without disarming the tool.
  useEffect(() => {
    registerDraftCancel(() => {
      if (vertexDraft || dragDraft) {
        setVertexDraft(null);
        setDragDraft(null);
        return true;
      }
      return false;
    });
    return () => registerDraftCancel(null);
  }, [vertexDraft, dragDraft]);

  // A tool change abandons the draft — adjusted during render (the
  // documented reset-on-prop-change pattern), never in an effect.
  const [draftKey, setDraftKey] = useState<string>(
    `${mode.open}:${mode.tool ?? ""}`,
  );
  const nextKey = `${mode.open}:${mode.tool ?? ""}`;
  if (draftKey !== nextKey) {
    setDraftKey(nextKey);
    setVertexDraft(null);
    setDragDraft(null);
    setCursor(null);
  }

  const toGround = useCallback(
    (e: { clientX: number; clientY: number }): Ground | null =>
      camera ? camera.unproject({ x: e.clientX, y: e.clientY }) : null,
    [camera],
  );

  const toScreen = useCallback(
    (ground: Ground): { x: number; y: number } | null => {
      if (!camera || !rect) return null;
      const p = camera.project(ground);
      return { x: p.x - rect.left, y: p.y - rect.top };
    },
    [camera, rect],
  );

  const screenDistance = useCallback(
    (a: Ground, b: Ground): number => {
      const pa = toScreen(a);
      const pb = toScreen(b);
      if (!pa || !pb) return Infinity;
      return Math.hypot(pa.x - pb.x, pa.y - pb.y);
    },
    [toScreen],
  );

  const finishVertexDraft = useCallback(
    (draft: VertexDraft) => {
      setVertexDraft(null);
      if (draft.tool === "line") {
        if (draft.positions.length < 2) return;
        void commit({
          kind: "line",
          geometry: { type: "LineString", coordinates: draft.positions },
        });
        return;
      }
      if (draft.positions.length < 3) return;
      void commit({
        kind: "polygon",
        geometry: {
          type: "Polygon",
          coordinates: [closeRing(draft.positions)],
        },
      });
    },
    [commit],
  );

  // Enter finishes a vertex draft; Backspace removes the last vertex.
  useEffect(() => {
    if (!armedShape) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && vertexDraft) {
        e.preventDefault();
        finishVertexDraft(vertexDraft);
      }
      if ((e.key === "Backspace" || e.key === "Delete") && vertexDraft) {
        e.preventDefault();
        const positions = vertexDraft.positions.slice(0, -1);
        setVertexDraft(
          positions.length ? { ...vertexDraft, positions } : null,
        );
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [armedShape, vertexDraft, finishVertexDraft]);

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!armedShape || e.button !== 0) return;
    const ground = toGround(e);
    if (!ground) return;
    const tool = mode.tool;
    if (tool === "rectangle" || tool === "circle" || tool === "freehand") {
      svgRef.current?.setPointerCapture(e.pointerId);
      setDragDraft({ tool, start: ground, current: ground, path: [ground] });
    }
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!armedShape) return;
    const ground = toGround(e);
    if (!ground) return;
    setCursor(ground);
    setDragDraft((draft) => {
      if (!draft) return draft;
      if (draft.tool === "freehand") {
        const last = draft.path[draft.path.length - 1];
        if (screenDistance(last, ground) < SAMPLE_PX)
          return { ...draft, current: ground };
        return { ...draft, current: ground, path: [...draft.path, ground] };
      }
      return { ...draft, current: ground };
    });
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragDraft) return;
    svgRef.current?.releasePointerCapture(e.pointerId);
    const draft = dragDraft;
    setDragDraft(null);
    if (draft.tool === "rectangle") {
      const p = toScreen(draft.start);
      const q = toScreen(draft.current);
      if (!p || !q || Math.abs(p.x - q.x) < 4 || Math.abs(p.y - q.y) < 4)
        return;
      void commit({
        kind: "rectangle",
        geometry: {
          type: "Polygon",
          coordinates: [rectangleRing(draft.start, draft.current)],
        },
      });
      return;
    }
    if (draft.tool === "circle") {
      const radiusKm = haversineKm(draft.start, draft.current);
      const p = toScreen(draft.start);
      const q = toScreen(draft.current);
      if (!p || !q || Math.hypot(p.x - q.x, p.y - q.y) < 4) return;
      void commit({
        kind: "circle",
        geometry: {
          type: "Polygon",
          coordinates: [circleRing(draft.start, radiusKm)],
        },
      });
      return;
    }
    // Freehand always closes into a polygon.
    if (draft.path.length >= 3)
      void commit({
        kind: "freehand",
        geometry: { type: "Polygon", coordinates: [closeRing(draft.path)] },
      });
  };

  const onClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!armedShape) return;
    const ground = toGround(e);
    if (!ground) return;
    const tool = mode.tool;
    if (tool === "point") {
      void commit({ kind: "point", geometry: { type: "Point", coordinates: ground } });
      return;
    }
    if (tool === "line" || tool === "polygon") {
      const draft =
        vertexDraft && vertexDraft.tool === tool
          ? vertexDraft
          : { tool, positions: [] as Ground[] };
      // Closing on the first vertex.
      if (
        tool === "polygon" &&
        draft.positions.length >= 3 &&
        screenDistance(draft.positions[0], ground) < SNAP_PX
      ) {
        finishVertexDraft(draft);
        return;
      }
      setVertexDraft({ ...draft, positions: [...draft.positions, ground] });
    }
  };

  const onDoubleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!armedShape) return;
    e.preventDefault();
    if (!vertexDraft) return;
    // The double-click's own second vertex is the duplicate.
    const positions =
      vertexDraft.positions.length > 1
        ? vertexDraft.positions.slice(0, -1)
        : vertexDraft.positions;
    finishVertexDraft({ ...vertexDraft, positions });
  };

  /* ---------- rendering ---------- */

  const path = (positions: Ground[], close: boolean): string => {
    const pts = positions
      .map((g) => toScreen(g))
      .filter((p): p is { x: number; y: number } => p !== null);
    if (!pts.length) return "";
    return (
      `M${pts.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" L")}` +
      (close ? " Z" : "")
    );
  };

  const draftShapes: React.ReactNode[] = [];
  if (armedShape && camera) {
    if (mode.tool === "point" && cursor) {
      const p = toScreen(cursor);
      if (p)
        draftShapes.push(
          <circle key="ghost" className={styles.draftGhost} cx={p.x} cy={p.y} r={6} />,
        );
    }
    if (vertexDraft) {
      const snap =
        mode.tool === "polygon" &&
        vertexDraft.positions.length >= 3 &&
        cursor !== null &&
        screenDistance(vertexDraft.positions[0], cursor) < SNAP_PX;
      draftShapes.push(
        <path
          key="edge"
          className={
            vertexDraft.tool === "line" ? styles.draftLine : styles.draftEdge
          }
          d={path(vertexDraft.positions, false)}
        />,
      );
      if (cursor && !snap) {
        const last = vertexDraft.positions[vertexDraft.positions.length - 1];
        const a = toScreen(last);
        const b = toScreen(cursor);
        if (a && b)
          draftShapes.push(
            <line
              key="rubber"
              className={styles.draftRubber}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
            />,
          );
      }
      vertexDraft.positions.forEach((g, i) => {
        const p = toScreen(g);
        if (!p) return;
        const first = i === 0 && vertexDraft.tool === "polygon";
        draftShapes.push(
          <circle
            key={`vx-${i}`}
            className={
              first && snap
                ? `${styles.draftVertex} ${styles.draftVertexSnap}`
                : styles.draftVertex
            }
            cx={p.x}
            cy={p.y}
            r={first && snap ? 6.5 : 4}
          />,
        );
      });
    }
    if (dragDraft) {
      if (dragDraft.tool === "rectangle")
        draftShapes.push(
          <path
            key="rect"
            className={styles.draftEdge}
            d={path(rectangleRing(dragDraft.start, dragDraft.current), true)}
          />,
        );
      if (dragDraft.tool === "freehand")
        draftShapes.push(
          <path
            key="free"
            className={styles.draftEdge}
            d={path(dragDraft.path, false)}
          />,
        );
      if (dragDraft.tool === "circle") {
        const radiusKm = haversineKm(dragDraft.start, dragDraft.current);
        const centre = toScreen(dragDraft.start);
        const edge = toScreen(dragDraft.current);
        if (centre && edge) {
          draftShapes.push(
            <path
              key="circle"
              className={styles.draftEdge}
              d={path(circleRing(dragDraft.start, radiusKm), true)}
            />,
            <line
              key="radius"
              className={styles.draftRubber}
              x1={centre.x}
              y1={centre.y}
              x2={edge.x}
              y2={edge.y}
            />,
            <text
              key="label"
              className={styles.draftLabel}
              x={edge.x + 12}
              y={edge.y - 10}
            >
              r ≈ {formatDistanceKm(radiusKm)}
            </text>,
          );
        }
      }
    }
  }

  // The selection mark: the outline every kind gets, from its own
  // geometry — a ring around a point, which has no extent — and the
  // vertex handles only where the rule grants them: one
  // per vertex, the closing duplicate excluded; dragging moves live,
  // release commits.
  const handles: React.ReactNode[] = [];
  const mark =
    selectedGeometry && camera && !armedShape
      ? selectionMarkFor(
          selectedGeometry.selection.kind,
          selectedGeometry.geometry,
        )
      : null;
  if (mark?.shape === "point") {
    const p = toScreen(mark.position);
    if (p)
      handles.push(
        <circle
          key="sel"
          className={styles.draftLine}
          cx={p.x}
          cy={p.y}
          r={POINT_MARK_PX}
        />,
      );
  }
  if (mark?.shape === "outline" && selectedGeometry) {
    const trace =
      draggingHandle !== null
        ? mark.trace.map((g, i) =>
            i === draggingHandle.index ||
            (draggingHandle.index === 0 && i === mark.trace.length - 1)
              ? draggingHandle.position
              : g,
          )
        : mark.trace;
    handles.push(
      <path
        key="sel"
        className={styles.draftLine}
        d={path(trace, mark.closed)}
      />,
    );
    mark.handles.forEach((g, i) => {
      const p = toScreen(trace[i]);
      if (!p) return;
      handles.push(
        <circle
          key={`h-${i}`}
          className={styles.handle}
          cx={p.x}
          cy={p.y}
          r={5.5}
          role="button"
          aria-label={`Move vertex ${i + 1}`}
          onPointerDown={(e) => {
            e.stopPropagation();
            (e.target as Element).setPointerCapture(e.pointerId);
            setDraggingHandle({ index: i, position: g });
          }}
          onPointerMove={(e) => {
            if (!draggingHandle) return;
            const ground = toGround(e);
            if (ground)
              setDraggingHandle({ index: draggingHandle.index, position: ground });
          }}
          onPointerUp={() => {
            if (!draggingHandle) return;
            const { index, position } = draggingHandle;
            setDraggingHandle(null);
            void onMoveVertex(selectedGeometry.selection, index, position);
          }}
        />,
      );
    });
  }

  const hasHandles = mark?.shape === "outline" && mark.handles.length > 0;

  if (!mode.open && !selectedGeometry) return null;
  return (
    <svg
      ref={measureRef}
      className={styles.overlay}
      data-armed={armedShape ? "" : undefined}
      // Decorative while drafting and while a selection mark has no
      // handle; EXPOSED while vertex handles exist — hiding the subtree
      // that holds role="button" handles removed them from the
      // accessibility tree entirely (browser round).
      aria-hidden={hasHandles ? undefined : true}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onPointerLeave={() => setCursor(null)}
    >
      {draftShapes}
      {handles}
    </svg>
  );
}
