import { act, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EXPORT_IMAGE_DEFINITION_SCHEMA,
  definitionRenderProblems,
  type ExportImageDefinition,
  type SizeStep,
} from "@/lib/export/image-definition";
import { validateAgainstSchema } from "@/lib/export/schema-validate";
import type { MapWithLayers } from "@/lib/metadata/maps";
import type { InstanceDefaults } from "@/lib/settings/defaults";
import type { LayerStyle } from "@/lib/style/style";
import { installDomHost } from "../../testing/dom-host";
import { ScreenDefaultsProvider } from "../../screen-defaults";
import type { CameraHandle } from "../../map/camera-handle";
import type { NamedStyle } from "../../map/LegendPanel";
import type { Viewport } from "../../map/MapCanvas";
import { ExportImageCard } from "./ExportImageCard";
import { buildExportStage } from "./export-stage";
import { useExportCard } from "./use-export-card";

/**
 * A fresh export card opens at the instance's starting width and shape, as
 * the page handed them down when it opened, with every other opening rule
 * as before, the map-size step judged at that shape. An open card keeps
 * the definition it opened on when the page hands down others; its next
 * opening takes them. The card is wired as the builder wires it. The
 * Export menu's own read of the instance's latest defaults never answers
 * here, so the page's snapshot stands throughout.
 */

const rail = vi.hoisted(() => ({ shown: [] as { def: ExportImageDefinition; mapStep: SizeStep; aspect: string }[] }));
// The preview's map and the download pipeline need a browser and play no
// part in what the card opens on.
vi.mock("./ExportComposition", () => ({ ExportComposition: () => null }));
vi.mock("./download", () => ({ composeAndDownload: async () => {} }));
vi.mock("./ExportOptionsRail", () => ({
  ExportOptionsRail: (props: { def: ExportImageDefinition; mapStep: SizeStep; aspect: string }) => {
    rail.shown.push({ def: props.def, mapStep: props.mapStep, aspect: props.aspect });
    return null;
  },
}));

const PRODUCT = {
  "newMap.basemap": null, "newMap.latitude": 40, "newMap.longitude": 0, "newMap.zoom": 1.3, "newMap.legendCorner": null,
  "newLayer.colorCycle": "uber_viz_qualitative", "newLayer.pointOpacity": 72, "newLayer.lineOpacity": 95,
  "newLayer.areaOpacity": 50, "newLayer.lineWidth": 2, "newLayer.pointRadius": 3,
  "canvas.opens": "full", "canvas.minimap": "auto", "canvas.resultsBand": "closed",
  "sqlConsole.textSize": "12", "sqlConsole.lineWrap": false, "imageExport.width": "1920", "imageExport.shape": "4:3",
} as const satisfies InstanceDefaults;
type Width = "1280" | "1920" | "2560";
type Shape = "16:9" | "4:3" | "1:1";
const exportDefaults = (width: Width, shape: Shape): InstanceDefaults =>
  ({ ...PRODUCT, "imageExport.width": width, "imageExport.shape": shape });

/** Where the builder's camera stands and how wide its canvas is. */
interface Builder { camera: Viewport; canvasWidth: number }
const FAR: Builder = { camera: { lng: 13.4, lat: 52.52, zoom: 11.25, pitch: 30, bearing: -15 }, canvasWidth: 960 };
// The three builders near the zoom ceiling the captured opening holds.
const NEAR: Builder = { camera: { lng: 2.35, lat: 48.85, zoom: 23.5 }, canvasWidth: 800 };
const NEARER: Builder = { camera: { lng: 2.35, lat: 48.85, zoom: 23.9 }, canvasWidth: 800 };
const AT: Builder = { camera: { lng: 2.35, lat: 48.85, zoom: 24 }, canvasWidth: 600 };

const STYLE: LayerStyle = { fill: { type: "constant", color: { r: 18, g: 147, b: 154, a: 1 } }, fillOpacity: 0.72,
  stroke: { r: 12, g: 16, b: 24, a: 1 }, strokeOpacity: 0.85, strokeWidth: 0, pointRadius: 3, opacity: 1 };
const legendLayers: NamedStyle[] = [{ id: "stations", name: "Stations", style: STYLE, visible: true }];
const mapAt = (camera: Viewport): MapWithLayers => ({ id: "map", name: "Survey", viewport: camera, basemap: null,
  customBasemap: null, basemapLayers: null, note: null, legendCorner: null, legendOrder: null, timeline: null, widgets: [],
  widgetsPublished: true, publishToken: null, publishedAt: null, published: false,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", layers: [] });

type Card = ReturnType<typeof useExportCard>;

/** The builder's side of the card: no live camera handle, the settled
 * camera, the canvas's width; the card shown once Image opens it. */
function Host({ builder, onCard }: { builder: Builder; onCard: (card: Card) => void }) {
  const cameraRef = useRef<CameraHandle | null>(null);
  const viewportRef = useRef<Viewport | null>(builder.camera);
  const canvasRef = useRef({ clientWidth: builder.canvasWidth } as HTMLDivElement);
  const card = useExportCard(cameraRef, viewportRef, canvasRef, builder.camera);
  useEffect(() => onCard(card));
  if (!card.seed) return null;
  return <ExportImageCard onClose={() => {}} stage={buildExportStage({ map: mapAt(builder.camera), appearance: "light",
    layers: [], basemapUrl: "https://tiles.example.test/style.json", basemapKind: "vector", fallbackColor: "#f4f1ea",
    liveFilters: null, seed: card.seed, legendLayers, widgets: [], values: null,
    valuesState: { status: "current", error: null }, selections: [], attribution: [] })} />;
}

const cleanups: (() => void)[] = [];
beforeEach(() => vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} }));
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.unstubAllGlobals();
  rail.shown.length = 0;
});

/** The builder under the defaults a page handed down (none: no provider). */
async function builderUnder(builder: Builder, defaults: InstanceDefaults | null) {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  rail.shown.length = 0;
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  const host = installDomHost();
  const root = createRoot(host.document.body as unknown as Element);
  cleanups.push(() => { act(() => root.unmount()); host.uninstall(); });
  let card: Card | null = null;
  const keep = (next: Card) => { card = next; };
  const tree = (handed: InstanceDefaults | null) => {
    const shown = <Host builder={builder} onCard={keep} />;
    return handed ? <ScreenDefaultsProvider defaults={handed}>{shown}</ScreenDefaultsProvider> : shown;
  };
  await act(async () => root.render(tree(defaults)));
  return {
    handDown: (handed: InstanceDefaults) => act(async () => root.render(tree(handed))),
    /** Image chosen from the Export menu: whether the card opened. */
    open: async () => {
      let opens = false;
      await act(async () => { opens = card!.open(); });
      return opens;
    },
    close: () => act(async () => card!.close()),
    available: () => card!.available(),
    /** What the card shows now: its definition, map-size step and shape. */
    shown: () => rail.shown.at(-1) ?? null,
  };
}

/** Each starting width and shape, with the size the card must open at and
 * the S step's composition width at that shape (a 1080 short side). */
const SEEDS: [Width, Shape, number, string, number][] = [
  ["1280", "16:9", 720, "wide", 1920], ["1920", "16:9", 1080, "wide", 1920], ["2560", "16:9", 1440, "wide", 1920],
  ["1280", "4:3", 960, "classic", 1440], ["1920", "4:3", 1440, "classic", 1440], ["2560", "4:3", 1920, "classic", 1440],
  ["1280", "1:1", 1280, "square", 1080], ["1920", "1:1", 1920, "square", 1080], ["2560", "1:1", 2560, "square", 1080],
];

describe("a fresh export card", () => {
  it.each(SEEDS)("opens at %s px and %s: %i px tall, the %s shape chosen, at S", async (width, shape, height, aspect, space) => {
    const builder = await builderUnder(FAR, exportDefaults(width, shape));
    expect(builder.available()).toBe(true);
    expect(await builder.open()).toBe(true);
    const { def, mapStep, aspect: chosen } = builder.shown()!;
    expect([def.size, mapStep, chosen]).toEqual([{ width: Number(width), height }, "s", aspect]);
    // Laid out at S for that shape, on the ground the builder shows.
    expect(def.mapScale).toBeCloseTo(Number(width) / space, 12);
    expect(def.viewport.zoom).toBeCloseTo(11.25 + Math.log2(space / 960), 12);
    // A definition the render route and the export API accept.
    expect(validateAgainstSchema(def, EXPORT_IMAGE_DEFINITION_SCHEMA)).toEqual([]);
    expect(definitionRenderProblems(def)).toEqual([]);
  });

  it("opens at the product's 1920 px and 4:3 with none handed down", async () => {
    const builder = await builderUnder(FAR, null);
    expect(await builder.open()).toBe(true);
    expect([builder.shown()!.def.size, builder.shown()!.mapStep, builder.shown()!.aspect]).toEqual([{ width: 1920, height: 1440 }, "s", "classic"]);
  });

  // The opening step is S, or the first coarser step the engine can draw
  // from here, judged in the starting shape's spaces: a wide shape's are
  // wider, so near the ceiling a 16:9 card opens coarser or not at all,
  // and a square one finer, than a 4:3 card from the same builder.
  const ceiling = (shape: Shape, [near, nearer, at]: (SizeStep | null)[]) => [
    { shape, from: "zoom 23.5 at 800 px", at: NEAR, step: near },
    { shape, from: "zoom 23.9 at 800 px", at: NEARER, step: nearer },
    { shape, from: "zoom 24 at 600 px", at: AT, step: at },
  ].map((row) => ({ ...row, opens: row.step ? `at ${row.step.toUpperCase()}` : "not at all" }));
  it.each([
    ...ceiling("16:9", ["l", null, null]),
    ...ceiling("4:3", ["m", "l", null]),
    ...ceiling("1:1", ["s", "m", "l"]),
  ])("near the zoom ceiling at $shape, from $from, opens $opens", async ({ shape, at: from, step }) => {
    const builder = await builderUnder(from, exportDefaults("1920", shape));
    expect(builder.available()).toBe(step !== null);
    expect(await builder.open()).toBe(step !== null);
    if (step === null) {
      expect(builder.shown()).toBeNull();
      return;
    }
    const { def, mapStep } = builder.shown()!;
    expect(mapStep).toBe(step);
    expect(def.viewport.zoom).toBeLessThanOrEqual(24);
    expect(definitionRenderProblems(def)).toEqual([]);
  });

  it("keeps its definition when the page hands down others while it is open; the next opening takes them", async () => {
    const builder = await builderUnder(FAR, exportDefaults("2560", "1:1"));
    await builder.open();
    const opened = builder.shown()!;
    expect(opened.def.size).toEqual({ width: 2560, height: 2560 });
    const before = rail.shown.length;
    await builder.handDown(exportDefaults("1280", "16:9"));
    // The card drew again under the new hand-down, on the definition it opened on.
    expect(rail.shown.length).toBeGreaterThan(before);
    expect([builder.shown()!.def, builder.shown()!.aspect]).toEqual([opened.def, "square"]);
    await builder.close();
    await builder.open();
    expect([builder.shown()!.def.size, builder.shown()!.aspect]).toEqual([{ width: 1280, height: 720 }, "wide"]);
  });
});
