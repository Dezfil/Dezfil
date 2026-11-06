import { act, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MapWithLayers } from "@/lib/metadata/maps";
import { cssRules } from "../../testing/css-rules";
import { installDomHost, type HostElement } from "../../testing/dom-host";
import type { CameraHandle } from "../../map/camera-handle";
import type { Viewport } from "../../map/MapCanvas";
import { ExportImageCard } from "./ExportImageCard";
import { buildExportStage } from "./export-stage";
import { useExportCard } from "./use-export-card";

/**
 * Export image's bottom row (the attribution note, an export error, Close
 * and Download PNG) sits under the options rather than at their end: the
 * options scroll, the row never does. The test host computes no layout,
 * so the structure is read from the mounted card and the scrolling from
 * the stylesheet; a browser test holds where the row is drawn.
 */

vi.mock("./ExportComposition", () => ({ ExportComposition: () => null }));
vi.mock("./download", () => ({ composeAndDownload: async () => {} }));

const SHEET = "src/components/builder/export/ExportImageCard.module.css";
const body = (selector: string) => cssRules(SHEET).filter((r) => r.selector === selector).map((r) => r.body).join(";");
const declares = (selector: string, property: string, value: string) =>
  new RegExp(`(^|;)\\s*${property}\\s*:\\s*${value}\\s*(;|$)`).test(body(selector));

const camera: Viewport = { lng: 13.4, lat: 52.52, zoom: 11.25, pitch: 0, bearing: 0 };
const map: MapWithLayers = { id: "map", name: "Survey", viewport: camera, basemap: null, customBasemap: null, basemapLayers: null,
  note: null, legendCorner: null, legendOrder: null, timeline: null, widgets: [], widgetsPublished: true, publishToken: null,
  publishedAt: null, published: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", layers: [] };

function Host({ onCard }: { onCard: (card: ReturnType<typeof useExportCard>) => void }) {
  const cameraRef = useRef<CameraHandle | null>(null);
  const viewportRef = useRef<Viewport | null>(camera);
  const canvasRef = useRef({ clientWidth: 960 } as HTMLDivElement);
  const card = useExportCard(cameraRef, viewportRef, canvasRef, camera);
  useEffect(() => onCard(card));
  if (!card.seed) return null;
  return <ExportImageCard onClose={() => {}} stage={buildExportStage({ map, appearance: "light", layers: [],
    basemapUrl: "https://tiles.example.test/style.json", basemapKind: "vector", fallbackColor: "#f4f1ea", liveFilters: null,
    seed: card.seed, legendLayers: [], widgets: [], values: null, valuesState: { status: "current", error: null },
    selections: [], attribution: [] })} />;
}

let host: ReturnType<typeof installDomHost>, root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  host = installDomHost();
  root = createRoot(host.document.body as unknown as Element);
});
afterEach(() => { act(() => root.unmount()); host.uninstall(); vi.unstubAllGlobals(); });

it("keeps the bottom row outside the scrolling options, and only the options scroll", async () => {
  let card: ReturnType<typeof useExportCard> | null = null;
  await act(async () => root.render(<Host onCard={(next) => { card = next; }} />));
  await act(async () => { card!.open(); });

  const options = host.document.querySelector("[data-export-options]") as HostElement;
  const foot = host.document.querySelector("[data-export-foot]") as HostElement;
  expect(options).not.toBeNull();
  expect(foot).not.toBeNull();
  // Siblings in the rail, the row after the options and never inside them.
  expect(foot.parentNode).toBe(options.parentNode);
  expect(options.querySelector("[data-export-foot]")).toBeNull();
  expect(options.parentNode!.childNodes.at(-1)).toBe(foot);
  expect(foot.textContent).toContain("PNG · attribution included");
  expect(foot.querySelectorAll("button").map((b) => b.textContent)).toEqual(["Close", "Download PNG"]);

  const rail = options.parentNode as HostElement;
  expect(rail.className).toMatch(/(^|\s)_rail_/);
  expect(options.className).toMatch(/(^|\s)_railOptions_/);
  expect(foot.className).toMatch(/(^|\s)_railFoot_/);
  // The rail itself does not scroll; the options take the room left and
  // scroll inside it; the row keeps its height.
  expect(body(".rail")).not.toMatch(/overflow/);
  expect(declares(".rail", "min-height", "0")).toBe(true);
  expect(declares(".railOptions", "overflow-y", "auto")).toBe(true);
  expect(declares(".railOptions", "min-height", "0")).toBe(true);
  expect(declares(".railOptions", "flex", "1")).toBe(true);
  expect(declares(".railFoot", "flex-shrink", "0")).toBe(true);
  expect(body(".railFoot")).not.toMatch(/margin-top/);
});
