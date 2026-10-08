import { act, useRef, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExportImageDefinition, SizeStep } from "@/lib/export/image-definition";
import type { MapWithLayers } from "@/lib/metadata/maps";
import type { InstanceDefaults } from "@/lib/settings/defaults";
import type { LayerStyle } from "@/lib/style/style";
import { installDomHost } from "../../testing/dom-host";
import { ScreenDefaultsProvider } from "../../screen-defaults";
import type { CameraHandle } from "../../map/camera-handle";
import type { NamedStyle } from "../../map/LegendPanel";
import type { Viewport } from "../../map/MapCanvas";
import { wire, type Wire } from "../../workflow-canvas/fetch-wire";
import { ExportControl } from "./ExportControl";
import { ExportImageCard } from "./ExportImageCard";
import { buildExportStage } from "./export-stage";
import { useExportCard } from "./use-export-card";

/**
 * A builder page can stay open while an admin changes what a fresh image
 * card starts at, so the page's own snapshot of the instance's defaults
 * can be older than the instance. Each time the person opens the Export
 * menu, the builder asks the runtime read again, once, and the answer
 * decides both whether Image is offered and what a card opened from that
 * menu starts at. Until the answer is in, or when the read fails, the
 * page's snapshot stands; a card already open keeps what it opened on, and
 * nothing is read while it is open. The builder is wired as it wires the
 * header's Export control and the card.
 */

const rail = vi.hoisted(() => ({ shown: [] as { def: ExportImageDefinition; mapStep: SizeStep; aspect: string }[] }));
vi.mock("./ExportComposition", () => ({ ExportComposition: () => null }));
vi.mock("./download", () => ({ composeAndDownload: async () => {} }));
vi.mock("./ExportOptionsRail", () => ({
  ExportOptionsRail: (props: { def: ExportImageDefinition; mapStep: SizeStep; aspect: string }) => {
    rail.shown.push({ def: props.def, mapStep: props.mapStep, aspect: props.aspect });
    return null;
  },
}));
// The menu needs a browser to place itself; here its trigger is a plain
// button that makes the opening gesture, and its items plain buttons.
vi.mock("../../ui/Menu", () => ({
  Menu: ({ onOpen, children }: { onOpen?: () => void; children: ReactNode }) => (
    <div data-menu>
      <button type="button" data-menu-trigger onClick={() => onOpen?.()}>Export</button>
      {children}
    </div>
  ),
  MenuItem: ({ onSelect, disabled, children }: { onSelect?: () => unknown; disabled?: boolean; children: ReactNode }) => (
    <button type="button" data-menu-item disabled={disabled} onClick={() => onSelect?.()}>{children}</button>
  ),
}));

const PRODUCT = {
  "newMap.basemap": null, "newMap.latitude": 40, "newMap.longitude": 0, "newMap.zoom": 1.3, "newMap.legendCorner": null,
  "newLayer.colorCycle": "uber_viz_qualitative", "newLayer.pointOpacity": 72, "newLayer.lineOpacity": 95,
  "newLayer.areaOpacity": 50, "newLayer.lineWidth": 2, "newLayer.pointRadius": 3,
  "canvas.opens": "full", "canvas.minimap": "auto", "canvas.resultsBand": "closed",
  "sqlConsole.textSize": "12", "sqlConsole.lineWrap": false, "imageExport.width": "1920", "imageExport.shape": "4:3",
} as const satisfies InstanceDefaults;

/** A page served after an admin changed the starting width and shape, so
 * its snapshot is neither the product's values nor any answer below. */
const SNAPSHOT = { ...PRODUCT, "imageExport.width": "2560", "imageExport.shape": "1:1" } as const satisfies InstanceDefaults;

/** The runtime read's answer once an admin changed the starting width and
 * shape: every default as it reports them. */
const readAnswer = (width: string, shape: string) => ({
  basemaps: [], palettes: [], renderCapFeatures: 100000, previewRows: 100, geocoderConfigured: false,
  defaults: { ...PRODUCT, "newMap.basemap": "auto", "newMap.legendCorner": "bottom-left", "imageExport.width": width, "imageExport.shape": shape },
});

interface Builder { camera: Viewport; canvasWidth: number }
const FAR: Builder = { camera: { lng: 13.4, lat: 52.52, zoom: 11.25 }, canvasWidth: 960 };
const NEARER: Builder = { camera: { lng: 2.35, lat: 48.85, zoom: 23.9 }, canvasWidth: 800 };
const AT: Builder = { camera: { lng: 2.35, lat: 48.85, zoom: 24 }, canvasWidth: 600 };

const STYLE: LayerStyle = { fill: { type: "constant", color: { r: 18, g: 147, b: 154, a: 1 } }, fillOpacity: 0.72,
  stroke: { r: 12, g: 16, b: 24, a: 1 }, strokeOpacity: 0.85, strokeWidth: 0, pointRadius: 3, opacity: 1 };
const legendLayers: NamedStyle[] = [{ id: "stations", name: "Stations", style: STYLE, visible: true }];
const mapAt = (camera: Viewport): MapWithLayers => ({ id: "map", name: "Survey", viewport: camera, basemap: null,
  customBasemap: null, basemapLayers: null, note: null, legendCorner: null, legendOrder: null, timeline: null, widgets: [],
  widgetsPublished: true, publishToken: null, publishedAt: null, published: false,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", layers: [] });
const DOWNLOADS = { start: () => false, active: () => false };

/** The builder's header control and its card, wired as the builder wires them. */
function BuilderPage({ builder }: { builder: Builder }) {
  const cameraRef = useRef<CameraHandle | null>(null);
  const viewportRef = useRef<Viewport | null>(builder.camera);
  const canvasRef = useRef({ clientWidth: builder.canvasWidth } as HTMLDivElement);
  const card = useExportCard(cameraRef, viewportRef, canvasRef, builder.camera);
  return (
    <>
      <ExportControl map={mapAt(builder.camera)} renders={{}} chromeClassName="" onExportImage={card.open}
        imageExportAvailable={card.available} layerDataDownloads={DOWNLOADS} />
      {card.seed && <span data-seed={`${card.seed.size.width}x${card.seed.size.height} ${card.seed.mapStep}`} />}
      {card.seed && <ExportImageCard onClose={card.close} stage={buildExportStage({ map: mapAt(builder.camera), appearance: "light",
        layers: [], basemapUrl: "https://tiles.example.test/style.json", basemapKind: "vector", fallbackColor: "#f4f1ea",
        liveFilters: null, seed: card.seed, legendLayers, widgets: [], values: null,
        valuesState: { status: "current", error: null }, selections: [], attribution: [] })} />}
    </>
  );
}

const cleanups: (() => void)[] = [];
let w: Wire;
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  w = wire();
  vi.stubGlobal("fetch", w.fetch);
});
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.unstubAllGlobals();
  rail.shown.length = 0;
});

/** The builder page served with the page's snapshot of the defaults. */
async function builderPage(builder: Builder, snapshot: InstanceDefaults = PRODUCT) {
  const host = installDomHost();
  const root = createRoot(host.document.body as unknown as Element);
  cleanups.push(() => { act(() => root.unmount()); host.uninstall(); });
  await act(async () => root.render(<ScreenDefaultsProvider defaults={snapshot}><BuilderPage builder={builder} /></ScreenDefaultsProvider>));
  const image = () => host.document.querySelectorAll("[data-menu-item]").find((item) => item.textContent.includes("Image"))!;
  const settle = () => act(async () => { await setImmediate(); });
  const reads = () => w.calls.filter((call) => call.method === "GET" && call.path === "/api/config");
  /** The read of the menu's current opening: the last one asked for, not
   * yet answered. Every answer below goes to it, never to an older one. */
  const current = () => {
    const read = reads().at(-1);
    expect(read?.answered, "the current opening's read is unanswered").toBe(false);
    return read!;
  };
  return {
    /** The person opens the Export menu. */
    openMenu: () => act(async () => host.document.querySelector("[data-menu-trigger]")!.click()),
    /** The runtime reads asked for so far, answered or not. */
    reads,
    /** The reads still waiting for an answer. */
    waiting: () => w.pending("GET", "/api/config"),
    answer: async (body: unknown) => { current().ok(body); await settle(); },
    refuse: async () => { current().refuse(500, "internal", "The instance could not answer."); await settle(); },
    cut: async () => { current().cut(); await settle(); },
    imageOffered: () => !image().disabled,
    /** The person chooses Image in the open menu. */
    chooseImage: () => act(async () => image().click()),
    closeCard: () => act(async () => host.document.querySelectorAll("button").find((b) => b.textContent === "Close")!.click()),
    /** What the open card shows: its size, map-size step and shape, or null with no card. */
    card: () => (host.document.querySelector("[data-export-card]") ? rail.shown.at(-1) ?? null : null),
    /** The open card's seed: the size and step it opened on. */
    seed: () => host.document.querySelector("[data-seed]")?.getAttribute("data-seed") ?? null,
  };
}

describe("an image card opened from the Export menu", () => {
  it("starts at the width and shape the instance has when the menu opens, not the page's older snapshot", async () => {
    const page = await builderPage(FAR);
    await page.openMenu();
    expect(page.reads()).toHaveLength(1);
    await page.answer(readAnswer("1280", "16:9"));
    await page.chooseImage();
    const { def, aspect } = page.card()!;
    expect([def.size, aspect]).toEqual([{ width: 1280, height: 720 }, "wide"]);
  });

  it("starts at the page's snapshot while the opening's read is in flight", async () => {
    const page = await builderPage(FAR, SNAPSHOT);
    await page.openMenu();
    expect(page.waiting()).toHaveLength(1);
    await page.chooseImage();
    expect([page.card()!.def.size, page.card()!.aspect]).toEqual([{ width: 2560, height: 2560 }, "square"]);
  });

  it.each([["refused", "refuse"], ["cut", "cut"]] as const)("starts at the page's snapshot once the opening's read is %s", async (_, failure) => {
    const page = await builderPage(FAR, SNAPSHOT);
    await page.openMenu();
    expect(page.reads()).toHaveLength(1);
    await page[failure]();
    // The read of this opening is settled, so the card below opens after it.
    expect(page.waiting()).toHaveLength(0);
    await page.chooseImage();
    expect([page.card()!.def.size, page.card()!.aspect]).toEqual([{ width: 2560, height: 2560 }, "square"]);
  });

  it("offers Image as the answer's shape allows, once the answer is in", async () => {
    // From zoom 23.9 at 800 px a 4:3 card opens at L and a 16:9 one cannot.
    const narrowing = await builderPage(NEARER);
    await narrowing.openMenu();
    expect(narrowing.imageOffered()).toBe(true);
    await narrowing.answer(readAnswer("1920", "16:9"));
    expect(narrowing.imageOffered()).toBe(false);
    cleanups.splice(0).forEach((cleanup) => cleanup());
    // From zoom 24 at 600 px no 4:3 card opens, and a square one opens at L.
    const widening = await builderPage(AT);
    await widening.openMenu();
    expect(widening.imageOffered()).toBe(false);
    await widening.answer(readAnswer("1920", "1:1"));
    expect(widening.imageOffered()).toBe(true);
    await widening.chooseImage();
    expect([widening.card()!.def.size, widening.card()!.mapStep]).toEqual([{ width: 1920, height: 1920 }, "l"]);
  });

  it("reads once per menu opening, and not while a card is open", async () => {
    const page = await builderPage(FAR);
    await page.openMenu();
    await page.openMenu();
    expect(page.reads()).toHaveLength(2);
    // The second opening's read answers; the first opening's never does.
    await page.answer(readAnswer("2560", "1:1"));
    await page.chooseImage();
    expect(page.card()!.def.size).toEqual({ width: 2560, height: 2560 });
    await page.openMenu();
    expect(page.reads()).toHaveLength(2);
  });

  it("keeps an open card as it opened when the menu's answer comes in after it", async () => {
    const page = await builderPage(FAR);
    await page.openMenu();
    await page.chooseImage();
    const opened = page.card()!.def;
    expect(page.seed()).toBe("1920x1440 s");
    await page.answer(readAnswer("1280", "16:9"));
    expect(page.seed()).toBe("1920x1440 s");
    expect(page.card()!.def).toEqual(opened);
    expect(opened.size).toEqual({ width: 1920, height: 1440 });
  });
});
