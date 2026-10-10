import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASEMAPS, BUILT_IN_ATTRIBUTION, type BasemapKey, type BasemapStyle } from "@/lib/basemap";
import type { PublishedView as ViewData } from "@/lib/publish/publish-service";
import { HostElement, installDomHost } from "../testing/dom-host";
import { wire } from "../workflow-canvas/fetch-wire";
import { PublishedView } from "./PublishedView";

/**
 * The published reader's theme control, as a reader presses it: the chrome
 * flips, and an explicit Dark or Light moves to its pair only when the
 * instance offers the pair, since the reader may choose only an offered
 * style. With the pair hidden the chrome changes and the style stays. Auto
 * keeps following the theme with Dark and Light offered or not; Streets,
 * Satellite and a map's own style never move with the theme.
 */

// The canvas needs WebGL: a stand-in records the style it is handed and
// draws nothing. Everything else is the shipped reader, over the few
// browser members it asks the window for (a coarse pointer, timers).
const canvas = vi.hoisted(() => ({ basemapUrl: null as string | null, basemapKind: null as string | null }));
vi.mock("next/dynamic", () => ({
  default: () => function Canvas(props: { basemapUrl: string; basemapKind: string }) {
    canvas.basemapUrl = props.basemapUrl; canvas.basemapKind = props.basemapKind;
    return null;
  },
}));

const url = (key: BasemapKey) => STYLES.find(b => b.key === key)!.url;
const SATELLITE: BasemapStyle = { key: "satellite", label: "Satellite", kind: "imagery", url: "/api/basemaps/satellite/style.json",
  attribution: [{ label: "Imagery fixture" }] };
const STYLES: BasemapStyle[] = [...BASEMAPS, SATELLITE];
/** The page's drawing list, each style marked offered or not. */
const choices = (hidden: BasemapKey[]) => STYLES.map(b => ({ ...b, offered: !hidden.includes(b.key) }));
const CUSTOM = { url: "https://charts.example/harbour/style.json", name: "Harbour chart", attribution: [{ label: "© Fixture Charts" }] };

/** A published view on `key` (null = Auto), as the server assembles it. */
function viewOn(key: BasemapKey | null, opts: { custom?: boolean } = {}): ViewData {
  const custom = opts.custom ? CUSTOM : null;
  return {
    name: "Harbour", viewport: { lng: 0, lat: 40, zoom: 1.3, pitch: 0, bearing: 0 }, theme: "dark",
    basemapUrl: custom ? custom.url : key ? url(key) : url("dark"),
    basemapForTheme: key === null && !custom ? { light: url("light"), dark: url("dark") } : null,
    basemapKey: key, customBasemap: custom, basemapPinned: false,
    basemapKind: key === "satellite" && !custom ? "imagery" : "vector",
    basemapAttribution: custom ? custom.attribution : key === "satellite" ? SATELLITE.attribution : BUILT_IN_ATTRIBUTION,
    basemapLayers: null, note: null, legendCorner: null, legendOrder: null, timeline: null, layers: [], widgets: [],
    viewerControls: { tilt: true, fit: true, coords: true, theme: true, basemap: true },
  } as unknown as ViewData;
}

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.unstubAllGlobals(); canvas.basemapUrl = null; canvas.basemapKind = null; });

/** The reader over `view`, the page's drawing list hiding `hidden`. */
async function open(view: ViewData, hidden: BasemapKey[] = []) {
  const host = installDomHost();
  Object.assign(host.window, { setInterval, clearInterval, setTimeout, clearTimeout,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  vi.stubGlobal("HTMLElement", HostElement);
  const w = wire(); vi.stubGlobal("fetch", w.fetch);
  const page = host.document.createElement("div");
  page.setAttribute("data-published-view", ""); page.setAttribute("data-view-theme", view.theme);
  host.document.body.appendChild(page);
  const root = createRoot(page as unknown as Element);
  cleanups.push(() => { act(() => root.unmount()); host.uninstall(); });
  const flush = (work: () => void) => act(async () => { work(); await w.settle(); });
  await flush(() => root.render(<PublishedView token="tok" basemapUrl={url("dark")} basemaps={choices(hidden)} />));
  await flush(() => w.pending("GET", "/api/published/tok")[0].ok(view));
  const toggle = () => host.document.querySelectorAll("button")
    .find(button => /^Switch to (light|dark) theme$/.test(button.getAttribute("aria-label") ?? ""))!;
  return {
    theme: () => page.getAttribute("data-view-theme"),
    press: () => flush(() => toggle().click()),
  };
}

describe("the reader's theme control", () => {
  it("leaves a Dark publication on Dark when Light is hidden: the chrome flips, the style stays", async () => {
    const reader = await open(viewOn("dark"), ["light"]);
    expect([reader.theme(), canvas.basemapUrl]).toEqual(["dark", url("dark")]);
    await reader.press();
    expect([reader.theme(), canvas.basemapUrl]).toEqual(["light", url("dark")]);
    await reader.press();
    expect([reader.theme(), canvas.basemapUrl]).toEqual(["dark", url("dark")]);
  });

  it("leaves a Light publication on Light when Dark is hidden", async () => {
    const reader = await open({ ...viewOn("light"), theme: "light" }, ["dark"]);
    expect([reader.theme(), canvas.basemapUrl]).toEqual(["light", url("light")]);
    await reader.press();
    expect([reader.theme(), canvas.basemapUrl]).toEqual(["dark", url("light")]);
  });

  it("still moves Dark to Light and back with both offered", async () => {
    const reader = await open(viewOn("dark"), ["streets"]);
    await reader.press();
    expect([reader.theme(), canvas.basemapUrl]).toEqual(["light", url("light")]);
    await reader.press();
    expect([reader.theme(), canvas.basemapUrl]).toEqual(["dark", url("dark")]);
  });

  it("moves a publication on a hidden Dark to an offered Light, and never back onto the hidden Dark", async () => {
    const reader = await open(viewOn("dark"), ["dark"]);
    expect(canvas.basemapUrl).toBe(url("dark"));
    await reader.press();
    expect([reader.theme(), canvas.basemapUrl]).toEqual(["light", url("light")]);
    await reader.press();
    expect([reader.theme(), canvas.basemapUrl]).toEqual(["dark", url("light")]);
  });

  it.each([[[] as BasemapKey[]], [["dark", "light"] as BasemapKey[]]])("keeps Auto following the theme (hidden: %j)", async hidden => {
    const reader = await open(viewOn(null), hidden);
    expect(canvas.basemapUrl).toBe(url("dark"));
    await reader.press();
    expect([reader.theme(), canvas.basemapUrl]).toEqual(["light", url("light")]);
    await reader.press();
    expect([reader.theme(), canvas.basemapUrl]).toEqual(["dark", url("dark")]);
  });

  it.each([
    ["Streets", "streets", []], ["Streets, hidden", "streets", ["streets"]],
    ["Satellite", "satellite", []], ["Satellite, hidden", "satellite", ["satellite"]],
  ] as [string, BasemapKey, BasemapKey[]][])("never moves %s with the theme", async (_name, key, hidden) => {
    const reader = await open(viewOn(key), hidden);
    await reader.press();
    expect([reader.theme(), canvas.basemapUrl, canvas.basemapKind]).toEqual(["light", url(key), key === "satellite" ? "imagery" : "vector"]);
  });

  it.each([[[] as BasemapKey[]], [["light"] as BasemapKey[]]])("never moves a map's own style with the theme (hidden: %j)", async hidden => {
    const reader = await open(viewOn("dark", { custom: true }), hidden);
    await reader.press();
    expect([reader.theme(), canvas.basemapUrl]).toEqual(["light", CUSTOM.url]);
  });
});
