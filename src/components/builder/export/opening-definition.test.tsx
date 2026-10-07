import { act, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BasemapLayers } from "@/lib/basemap-layers";
import type { Corner } from "@/lib/corners";
import type { Appearance } from "@/lib/export/image-definition";
import type { MapWithLayers } from "@/lib/metadata/maps";
import type { LayerStyle } from "@/lib/style/style";
import type { MapWidget } from "@/lib/widgets";
import { installDomHost } from "../../testing/dom-host";
import type { CameraHandle } from "../../map/camera-handle";
import type { NamedStyle } from "../../map/LegendPanel";
import type { Viewport } from "../../map/MapCanvas";
import { ExportImageCard } from "./ExportImageCard";
import { buildExportStage } from "./export-stage";
import { useExportCard } from "./use-export-card";

/**
 * A fresh export card opens on the definition it opened on before instance
 * defaults existed, for each builder below: the card is wired as the
 * builder wires it (its open state from the builder's camera and canvas,
 * its stage from the builder's state), and what it opens on is the
 * definition and map-size step it hands its options. The fixture was
 * captured from the product before any opening read a default, and is
 * compared, never regenerated, here.
 */
const FIXTURE = path.join(process.cwd(), "src/components/builder/export/fixtures/opening-definition.json");

const opened = vi.hoisted(() => ({ rail: [] as { def: unknown; mapStep: unknown }[] }));
// The preview's map and the download pipeline need a browser and play no
// part in what the card opens on.
vi.mock("./ExportComposition", () => ({ ExportComposition: () => null }));
vi.mock("./download", () => ({ composeAndDownload: async () => {} }));
vi.mock("./ExportOptionsRail", () => ({
  ExportOptionsRail: (props: { def: unknown; mapStep: unknown }) => {
    opened.rail.push({ def: props.def, mapStep: props.mapStep });
    return null;
  },
}));

interface Builder {
  appearance: Appearance;
  camera: Viewport;
  canvasWidth: number;
  legendCorner: Corner | null;
  legendShown: boolean;
  widgets: { id: string; visible: boolean }[];
  basemapLayers: BasemapLayers | null;
}

/** Each builder states what the opening rules turn on: the camera and the
 * canvas it is seen in, the saved legend corner with and without a legend
 * to show, the widgets shown, hidden basemap groups and the theme. The
 * last three sit near the zoom ceiling, where the opening step coarsens
 * and finally refuses to open. */
const BUILDERS: Record<string, Builder> = {
  "a new map in the light theme": { appearance: "light", camera: { lng: 0, lat: 40, zoom: 1.3 }, canvasWidth: 1180,
    legendCorner: null, legendShown: true, widgets: [], basemapLayers: null },
  "a saved bottom-right legend with widgets and hidden labels in the dark theme": { appearance: "dark",
    camera: { lng: 13.4, lat: 52.52, zoom: 11.25, pitch: 30, bearing: -15 }, canvasWidth: 960, legendCorner: "bottom-right",
    legendShown: true, widgets: [{ id: "count", visible: true }, { id: "hidden", visible: false }, { id: "total", visible: true }],
    basemapLayers: { labels: false } },
  "a saved bottom-right corner with no legend to show": { appearance: "light", camera: { lng: -73.98, lat: 40.75, zoom: 15 },
    canvasWidth: 1440, legendCorner: "bottom-right", legendShown: false, widgets: [], basemapLayers: null },
  "a saved top-right legend": { appearance: "dark", camera: { lng: 151.21, lat: -33.87, zoom: 9.5 }, canvasWidth: 720,
    legendCorner: "top-right", legendShown: true, widgets: [], basemapLayers: null },
  "near the zoom ceiling": { appearance: "light", camera: { lng: 2.35, lat: 48.85, zoom: 23.5 }, canvasWidth: 800,
    legendCorner: null, legendShown: true, widgets: [], basemapLayers: null },
  "nearer the zoom ceiling": { appearance: "light", camera: { lng: 2.35, lat: 48.85, zoom: 23.9 }, canvasWidth: 800,
    legendCorner: null, legendShown: true, widgets: [], basemapLayers: null },
  "at the zoom ceiling": { appearance: "light", camera: { lng: 2.35, lat: 48.85, zoom: 24 }, canvasWidth: 600,
    legendCorner: null, legendShown: true, widgets: [], basemapLayers: null },
};

const STYLE: LayerStyle = { fill: { type: "constant", color: { r: 18, g: 147, b: 154, a: 1 } }, fillOpacity: 0.72,
  stroke: { r: 12, g: 16, b: 24, a: 1 }, strokeOpacity: 0.85, strokeWidth: 0, pointRadius: 3, opacity: 1 };

function mapOf(builder: Builder): MapWithLayers {
  return { id: "map", name: "Survey", viewport: builder.camera, basemap: null, customBasemap: null,
    basemapLayers: builder.basemapLayers, note: null, legendCorner: builder.legendCorner, legendOrder: null, timeline: null,
    widgets: builder.widgets.map(widgetOf), widgetsPublished: true, publishToken: null, publishedAt: null, published: false,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", layers: [] };
}
function widgetOf({ id, visible }: { id: string; visible: boolean }): MapWidget {
  return { id, type: "formula", layerId: "stations", title: id, field: null, agg: "count", aggField: null, unit: null,
    note: null, format: null, visible };
}

/** The builder's side of the card, as the builder wires it: no live camera
 * handle, the settled camera, the canvas's width, and Image chosen from
 * the Export menu once the builder is on screen. */
function Host({ builder, onOpen }: { builder: Builder; onOpen: (opens: boolean) => void }) {
  const cameraRef = useRef<CameraHandle | null>(null);
  const viewportRef = useRef<Viewport | null>(builder.camera);
  const canvasRef = useRef({ clientWidth: builder.canvasWidth } as HTMLDivElement);
  const { seed, open } = useExportCard(cameraRef, viewportRef, canvasRef, builder.camera);
  useEffect(() => onOpen(open()), [open, onOpen]);
  if (!seed) return null;
  const map = mapOf(builder);
  const legendLayers: NamedStyle[] = [{ id: "stations", name: "Stations", style: STYLE, visible: builder.legendShown }];
  return <ExportImageCard onClose={() => {}} stage={buildExportStage({ map, appearance: builder.appearance,
    layers: [], basemapUrl: "https://tiles.example.test/style.json", basemapKind: "vector", fallbackColor: "#f4f1ea",
    liveFilters: null, seed, legendLayers, widgets: map.widgets, values: null,
    valuesState: { status: "current", error: null }, selections: [], attribution: [] })} />;
}

async function openOn(builder: Builder) {
  const host = installDomHost();
  const root = createRoot(host.document.body as unknown as Element);
  const answers: boolean[] = [];
  const onOpen = (opens: boolean) => { answers.push(opens); };
  opened.rail.length = 0;
  try {
    await act(async () => root.render(<Host builder={builder} onOpen={onOpen} />));
    expect(answers, "Image is chosen once").toHaveLength(1);
    if (!answers[0]) return { opens: false };
    const { def, mapStep } = opened.rail.at(-1)!;
    return { opens: true, mapStep, definition: def };
  } finally {
    act(() => root.unmount());
    host.uninstall();
  }
}

beforeEach(() => vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} }));
afterEach(() => vi.unstubAllGlobals());

it("opens a fresh card on today's definition and map-size step for every builder", async () => {
  const before = JSON.parse(readFileSync(FIXTURE, "utf8"));
  // What the comparison rests on is in the fixture: every builder, today's
  // starting width and 4:3 shape, and the ceiling's coarser steps.
  expect(Object.keys(before)).toEqual(Object.keys(BUILDERS));
  expect(before["a new map in the light theme"]).toMatchObject({ opens: true, mapStep: "s",
    definition: { size: { width: 1920, height: 1440 } } });
  expect(Object.values(before).map((card) => (card as { mapStep?: string }).mapStep ?? null)).toEqual(["s", "s", "s", "s", "m", "l", null]);
  const now: Record<string, unknown> = {};
  for (const [name, builder] of Object.entries(BUILDERS)) now[name] = await openOn(builder);
  expect(now).toEqual(before);
});
