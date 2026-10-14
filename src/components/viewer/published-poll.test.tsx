import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASEMAPS, BUILT_IN_ATTRIBUTION } from "@/lib/basemap";
import type { PublishedView as ViewData } from "@/lib/publish/publish-service";
import type { LayerRenderData } from "@/lib/layer-render";
import { defaultStyle } from "@/lib/style/defaults";
import { HostElement, installDomHost } from "../testing/dom-host";
import { wire, type WireCall } from "../workflow-canvas/fetch-wire";
import { PublishedView } from "./PublishedView";

/**
 * The published reader while tiles prepare: it reads the view again every
 * five seconds until they settle. A read that fails (refused, cut, or a
 * body that cannot be read) changes nothing on the page, and the poll
 * must carry on past it; leaving the page ends it.
 */

// The canvas needs WebGL: a stand-in draws nothing.
vi.mock("next/dynamic", () => ({ default: () => function Canvas() { return null; } }));

const render = (state: "building" | "ready"): LayerRenderData => ({
  layerId: "L", ok: true, mode: "tiled", geometryType: "POINT",
  tiles: state === "ready" ? { state, url: "/api/published/tok/tiles/L/{z}/{x}/{y}", bounds: [0, 0, 1, 1] } : { state },
});
const viewWith = (state: "building" | "ready"): ViewData => ({
  name: "Harbour", viewport: { lng: 0, lat: 40, zoom: 1.3, pitch: 0, bearing: 0 }, theme: "dark",
  basemapUrl: BASEMAPS[0].url, basemapForTheme: null, basemapKey: BASEMAPS[0].key, customBasemap: null, basemapPinned: false,
  basemapKind: "vector", basemapAttribution: BUILT_IN_ATTRIBUTION, basemapLayers: null, note: null, legendCorner: null,
  legendOrder: null, timeline: null, widgets: [],
  layers: [{
    id: "L", name: "Ports", style: defaultStyle("POINT"), visible: true, tooltip: null, popup: null, inLegend: false,
    viz: { type: "points" }, legendTitle: null, legendLabels: null, legendAttrs: null, render: render(state), liveFilters: [],
  }],
  viewerControls: { tilt: true, fit: true, coords: true, theme: true, basemap: true },
} as unknown as ViewData);

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// The poll's timer is faked; answers flush through the check queue, so
// the wire's own clock-based settle is not used.
const drain = async () => {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
};

async function open() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const host = installDomHost();
  Object.assign(host.window, { setInterval, clearInterval, setTimeout, clearTimeout,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  vi.stubGlobal("HTMLElement", HostElement);
  const w = wire(); vi.stubGlobal("fetch", w.fetch);
  const page = host.document.createElement("div");
  page.setAttribute("data-published-view", ""); page.setAttribute("data-view-theme", "dark");
  host.document.body.appendChild(page);
  const root = createRoot(page as unknown as Element);
  let mounted = true;
  const unmount = () => { if (mounted) { mounted = false; act(() => root.unmount()); } };
  cleanups.push(() => { unmount(); host.uninstall(); });
  const step = (work: () => void) => act(async () => { work(); await drain(); });
  const reads = () => w.calls.filter((c) => c.method === "GET" && c.path === "/api/published/tok");
  await step(() => root.render(<PublishedView token="tok" basemapUrl={BASEMAPS[0].url} basemaps={BASEMAPS} />));
  await step(() => reads()[0].ok(viewWith("building")));
  return {
    reads,
    /** The newest read, which must still be waiting for its answer. */
    latest: () => { const all = reads(); const last = all[all.length - 1]; expect(last.answered).toBe(false); return last; },
    answer: (work: () => void) => step(work),
    wait: (ms: number) => step(() => { vi.advanceTimersByTime(ms); }),
    preparing: () => page.textContent?.includes("preparing tiles") ?? false,
    title: () => page.querySelector("h1")?.textContent ?? null,
    unmount,
  };
}

describe("the published reader's tile poll", () => {
  it.each<[string, (read: WireCall) => void]>([
    ["refused", (read) => read.refuse(500, "internal", "The server failed.")],
    ["cut", (read) => read.cut()],
    ["answered with a body that cannot be read", (read) => read.bodyFailure()],
  ])("keeps polling past a read that is %s, then draws the settled tiles", async (_name, fail) => {
    const reader = await open();
    expect(reader.preparing()).toBe(true);
    await reader.wait(5000);
    expect(reader.reads()).toHaveLength(2);
    await reader.answer(() => fail(reader.latest()));
    // The page stays as it was: never the splash over a usable page.
    expect(reader.title()).toBe("Harbour");
    expect(reader.preparing()).toBe(true);
    await reader.wait(5000);
    expect(reader.reads()).toHaveLength(3);
    await reader.answer(() => reader.latest().ok(viewWith("ready")));
    expect(reader.preparing()).toBe(false);
    // Settled: nothing left to poll for.
    await reader.wait(15000);
    expect(reader.reads()).toHaveLength(3);
  });

  it("stops reading once the reader leaves, failed read or not", async () => {
    const reader = await open();
    await reader.wait(5000);
    await reader.answer(() => reader.latest().bodyFailure());
    reader.unmount();
    await reader.wait(15000);
    expect(reader.reads()).toHaveLength(2);
  });
});
