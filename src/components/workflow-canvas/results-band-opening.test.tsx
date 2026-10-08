import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstanceDefaults } from "@/lib/settings/defaults";
import { HostEvent, installDomHost } from "../testing/dom-host";
import { ScreenDefaultsProvider } from "../screen-defaults";
import { ResultsBand } from "./ResultsBand";

/**
 * The results band opens closed or open as the instance's default says
 * until this browser keeps the viewer's band state, which then wins. The
 * state is kept from the band's first move on, the viewer's or the first
 * run's, never at the opening itself, so a viewer who never moved it keeps
 * following the default. An open canvas's band stays as it opened when the
 * page hands down another default.
 */

vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a> }));

const PRODUCT = {
  "newMap.basemap": null, "newMap.latitude": 40, "newMap.longitude": 0, "newMap.zoom": 1.3, "newMap.legendCorner": null,
  "newLayer.colorCycle": "uber_viz_qualitative", "newLayer.pointOpacity": 72, "newLayer.lineOpacity": 95,
  "newLayer.areaOpacity": 50, "newLayer.lineWidth": 2, "newLayer.pointRadius": 3,
  "canvas.opens": "full", "canvas.minimap": "auto", "canvas.resultsBand": "closed",
  "sqlConsole.textSize": "12", "sqlConsole.lineWrap": false, "imageExport.width": "1920", "imageExport.shape": "4:3",
} as const satisfies InstanceDefaults;
const bandDefault = (band: "closed" | "open"): InstanceDefaults => ({ ...PRODUCT, "canvas.resultsBand": band });

const BAND_KEY = "dezfil.workflow.band";

function memoryStorage(entries: Record<string, string>) {
  const kept = new Map(Object.entries(entries));
  return {
    kept,
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, String(value)),
    removeItem: (key: string) => void kept.delete(key),
    key: (index: number) => [...kept.keys()][index] ?? null,
    get length() { return kept.size; },
  };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.unstubAllGlobals();
});

/** Opens the band under the defaults a page handed down (none: no provider
 * at all), with what this browser already keeps. */
async function open(defaults: InstanceDefaults | null, stored: Record<string, string> = {}) {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  const host = installDomHost();
  const storage = memoryStorage(stored);
  vi.stubGlobal("localStorage", storage);
  const root = createRoot(host.document.body as unknown as Element);
  cleanups.push(() => { act(() => root.unmount()); host.uninstall(); });
  const band = (runId: string | null) => (
    <ResultsBand runs={[]} activeRunId={runId} hostHeight={800} selected={null} tables={[]} operations={[]}
      nodeExists={() => false} onSelectNode={() => {}} onHeight={() => {}} onAddToMap={() => {}} onListingStale={() => {}} />
  );
  const render = async (handed: InstanceDefaults | null, runId: string | null = null) => act(async () => {
    root.render(handed ? <ScreenDefaultsProvider defaults={handed}>{band(runId)}</ScreenDefaultsProvider> : band(runId));
  });
  await render(defaults);
  const element = (selector: string) => host.document.querySelector(selector)!;
  return {
    render,
    storage,
    collapsed: () => element("[data-results-band]").getAttribute("data-collapsed") === "true",
    kept: () => (storage.kept.has(BAND_KEY) ? (JSON.parse(storage.kept.get(BAND_KEY)!) as { open: boolean }).open : null),
    pressBar: () => act(async () => element("[data-band-bar]").click()),
    collapse: () => act(async () => {
      element("[data-band-separator]").dispatchEvent(Object.assign(new HostEvent("keydown", { bubbles: true, cancelable: true }), { key: "Home" }));
    }),
  };
}

describe("the results band", () => {
  it("opens closed or open as the instance's default says while this browser keeps no band state, closed with none handed down", async () => {
    expect((await open(bandDefault("open"))).collapsed()).toBe(false);
    expect((await open(bandDefault("closed"))).collapsed()).toBe(true);
    expect((await open(null)).collapsed()).toBe(true);
  });

  it("opens as the viewer left it whatever the default", async () => {
    expect((await open(bandDefault("open"), { [BAND_KEY]: JSON.stringify({ open: false, height: null }) })).collapsed()).toBe(true);
    expect((await open(bandDefault("closed"), { [BAND_KEY]: JSON.stringify({ open: true, height: null }) })).collapsed()).toBe(false);
  });

  it("keeps nothing at its opening, so a viewer who never moved it keeps following the default", async () => {
    const band = await open(bandDefault("open"));
    expect(band.kept()).toBeNull();
    await band.collapse();
    expect([band.collapsed(), band.kept()]).toEqual([true, false]);
  });

  it("keeps every move from the first on, back to where it opened included", async () => {
    const band = await open(bandDefault("closed"));
    await band.pressBar();
    expect([band.collapsed(), band.kept()]).toEqual([false, true]);
    await band.collapse();
    expect([band.collapsed(), band.kept()]).toEqual([true, false]);
  });

  it("keeps the first run's opening, as it always has", async () => {
    const band = await open(bandDefault("closed"));
    await band.render(bandDefault("closed"), "run-1");
    expect([band.collapsed(), band.kept()]).toEqual([false, true]);
  });

  it("stays as it opened when the page hands down another default while the canvas is open", async () => {
    const band = await open(bandDefault("open"));
    await band.render(bandDefault("closed"));
    expect([band.collapsed(), band.kept()]).toEqual([false, null]);
  });
});
