import { useRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Layer, MapWithLayers } from "@/lib/metadata/maps";
import { defaultStyle } from "@/lib/style/defaults";
import type { FillPaint, LayerStyle } from "@/lib/style/style";
import { POINTS_VIZ } from "@/lib/viz";
import type { CameraHandle } from "../map/camera-handle";
import type { AppearanceDraft } from "./builder-shell-state";
import type { LayerRenderData } from "./render-data";
import { draftedStyle, nextStyleDraft } from "./style-draft";
import { mapWidgetEndpoints, useMapPresentation } from "./use-map-presentation";

/**
 * A slider previews while it moves and writes the layer on release, so a
 * value set without a release leaves its draft behind. Whatever is written
 * to the layer after that must still reach the canvas and the legend: the
 * draft keeps only the edits it made itself, and only while nothing newer
 * has been written to the same field.
 */

const saved: LayerStyle = { ...defaultStyle("POINT"), opacity: 1 };
const ramp: FillPaint = {
  type: "continuous",
  attribute: "fare",
  palette: "viridis",
  domain: [0, 100],
  stops: [
    { r: 0, g: 0, b: 0, a: 1 },
    { r: 255, g: 255, b: 255, a: 1 },
  ],
};

function layerWith(style: LayerStyle): Layer {
  return {
    id: "trips", mapId: "m", name: "Trips", sql: "SELECT 1", style, visible: true, tooltip: null, popup: null,
    publishedFields: null, inLegend: true, viz: POINTS_VIZ, filters: [], legendTitle: null, legendLabels: null,
    legendAttrs: null, ordinal: 0, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  };
}

/** What the canvas and the legend draw for the layer, read through the
 * builder's presentation as it mounts. */
function drawn(style: LayerStyle, draft: AppearanceDraft) {
  const map = { id: "m", name: "Map", viewport: { lng: 0, lat: 0, zoom: 2 }, widgets: [], layers: [layerWith(style)] } as unknown as MapWithLayers;
  const out: { canvas?: LayerStyle; legend?: LayerStyle } = {};
  function Probe() {
    const renders: Record<string, LayerRenderData> = {};
    const stage = useMapPresentation({
      map, renders, rendersRef: useRef(renders), mapRef: useRef<MapWithLayers | null>(map),
      endpoints: mapWidgetEndpoints(map.id, null), cameraRef: useRef<CameraHandle | null>(null),
      setFitBounds: () => {}, fail: () => {}, clearFailure: () => {}, appearanceDrafts: { trips: draft },
    });
    out.canvas = stage.stagedLayers[0].style;
    out.legend = stage.legendLayers[0].style;
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return out;
}

describe("a style draft left behind by a slider without its release", () => {
  // The opacity slider moved and was never released: its preview stands.
  const lingering = nextStyleDraft(undefined, saved, { opacity: 0.4 }, saved);

  it("draws its own edit while nothing else is written", () => {
    const { canvas, legend } = drawn(saved, lingering);
    expect(canvas?.opacity).toBe(0.4);
    expect(legend?.opacity).toBe(0.4);
  });

  it("does not mask a later write of the whole style: the canvas and the legend draw the committed ramp", () => {
    const written = { ...saved, fill: ramp };
    const { canvas, legend } = drawn(written, lingering);
    expect(canvas?.fill).toEqual(ramp);
    expect(legend?.fill).toEqual(ramp);
    // Its own edit still stands, as the slider still shows it.
    expect(canvas?.opacity).toBe(0.4);
  });

  it("gives way where the later write changed the field it edited", () => {
    expect(draftedStyle({ ...saved, opacity: 0.7 }, lingering).opacity).toBe(0.7);
  });

  it("is not where the next preview starts from: that builds on the written style", () => {
    const written = { ...saved, fill: ramp };
    const label = { attribute: "name", size: 14, color: { r: 255, g: 255, b: 255, a: 1 }, haloWidth: 1, haloColor: { r: 0, g: 0, b: 0, a: 1 } };
    const next = nextStyleDraft(lingering, written, { label }, written);
    const { canvas, legend } = drawn(written, next);
    expect(canvas?.fill).toEqual(ramp);
    expect(legend?.fill).toEqual(ramp);
    expect(canvas?.label).toEqual(label);
    expect(canvas?.opacity).toBe(0.4);
  });
});

describe("a preview taken while an earlier save of the same field is still settling", () => {
  // Released at 0.4: the map shows 0.4 at once, while the saved layer
  // still reads 1 until that save settles.
  const first = nextStyleDraft(undefined, saved, { opacity: 0.4 }, saved);
  const shown = { ...saved, opacity: 0.4 };
  // Dragged on to 0.7 before the save settles.
  const second = nextStyleDraft(first, saved, { opacity: 0.7 }, shown);

  it("draws the new preview while the save is in flight", () => {
    const { canvas, legend } = drawn(shown, second);
    expect(canvas?.opacity).toBe(0.7);
    expect(legend?.opacity).toBe(0.7);
  });

  it("still draws it once the save settles, the server's copy in place of the shown one", () => {
    const { canvas, legend } = drawn({ ...saved, opacity: 0.4 }, second);
    expect(canvas?.opacity).toBe(0.7);
    expect(legend?.opacity).toBe(0.7);
  });

  it("gives way to a later write of the same field", () => {
    expect(draftedStyle({ ...saved, opacity: 0.2 }, second).opacity).toBe(0.2);
  });
});
