import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstanceDefaults } from "@/lib/settings/defaults";
import { HostEvent, installDomHost } from "../testing/dom-host";
import { ScreenDefaultsProvider } from "../screen-defaults";
import { ResultsBand } from "./ResultsBand";

/**
 * The results band opens closed or open as the instance's default says
 * until the person chooses in this browser. Opening it, closing it and
 * resizing it are their choice, kept under the band's own key, and the
 * next canvas opens as they left it. A run opening the band is not their
 * choice and is never kept. The state the band kept before, written at
 * every opening whether anyone chose or not, is not read. An open
 * canvas's band stays as it opened when the page hands down another
 * default.
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

/** Where the person's choice is kept, and where the band kept its state
 * before, at every opening. */
const CHOICE_KEY = "dezfil.workflow.band-choice";
const OLD_KEY = "dezfil.workflow.band";
const old = (open: boolean) => JSON.stringify({ open, height: null });

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

/** Opens a canvas's band under the defaults a page handed down (none: no
 * provider at all), with what this browser already keeps. */
async function open(defaults: InstanceDefaults | null, stored: Record<string, string> = {}) {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  const host = installDomHost();
  const storage = memoryStorage(stored);
  vi.stubGlobal("localStorage", storage);
  let root: Root | null = null;
  const unmount = () => { if (root) { const mounted = root; act(() => mounted.unmount()); root = null; } };
  cleanups.push(() => { unmount(); host.uninstall(); });
  const band = (runId: string | null) => (
    <ResultsBand runs={[]} activeRunId={runId} hostHeight={800} selected={null} tables={[]} operations={[]}
      nodeExists={() => false} onSelectNode={() => {}} onHeight={() => {}} onAddToMap={() => {}} onListingStale={() => {}} />
  );
  const render = async (handed: InstanceDefaults | null, runId: string | null = null) => act(async () => {
    root ??= createRoot(host.document.body as unknown as Element);
    root.render(handed ? <ScreenDefaultsProvider defaults={handed}>{band(runId)}</ScreenDefaultsProvider> : band(runId));
  });
  await render(defaults);
  const element = (selector: string) => host.document.querySelector(selector)!;
  const key = (name: string) => act(async () => {
    element("[data-band-separator]").dispatchEvent(Object.assign(new HostEvent("keydown", { bubbles: true, cancelable: true }), { key: name }));
  });
  return {
    render,
    /** The same browser opens the next canvas: a fresh band, what is kept kept. */
    reopen: async () => { unmount(); await render(defaults); },
    storage,
    collapsed: () => element("[data-results-band]").getAttribute("data-collapsed") === "true",
    /** The person's kept choice, or null while they never chose. */
    choice: () => storage.kept.get(CHOICE_KEY) ?? null,
    pressBar: () => act(async () => element("[data-band-bar]").click()),
    /** The separator's keys: Home collapses, the arrows resize. */
    key,
  };
}

describe("the results band", () => {
  it("opens closed or open as the instance's default says while the person never chose, closed with none handed down", async () => {
    expect((await open(bandDefault("open"))).collapsed()).toBe(false);
    expect((await open(bandDefault("closed"))).collapsed()).toBe(true);
    expect((await open(null)).collapsed()).toBe(true);
  });

  it("opens as the person chose in this browser whatever the default", async () => {
    expect((await open(bandDefault("open"), { [CHOICE_KEY]: "closed" })).collapsed()).toBe(true);
    expect((await open(bandDefault("closed"), { [CHOICE_KEY]: "open" })).collapsed()).toBe(false);
  });

  it("does not read the state it kept before at every opening, and leaves it as it was", async () => {
    const closedByDefault = await open(bandDefault("closed"), { [OLD_KEY]: old(true) });
    expect([closedByDefault.collapsed(), closedByDefault.choice()]).toEqual([true, null]);
    const openByDefault = await open(bandDefault("open"), { [OLD_KEY]: old(false) });
    expect(openByDefault.collapsed()).toBe(false);
    await openByDefault.key("Home");
    expect([openByDefault.choice(), openByDefault.storage.kept.get(OLD_KEY)]).toEqual(["closed", old(false)]);
  });

  it("keeps nothing at its opening", async () => {
    const band = await open(bandDefault("open"));
    expect([...band.storage.kept.keys()]).toEqual([]);
  });

  it("keeps the person's opening, closing and resizing as their choice", async () => {
    const band = await open(bandDefault("closed"));
    await band.pressBar();
    expect([band.collapsed(), band.choice()]).toEqual([false, "open"]);
    await band.key("Home");
    expect([band.collapsed(), band.choice()]).toEqual([true, "closed"]);
    // Resized from its bar: open again, and so kept.
    await band.key("ArrowUp");
    expect([band.collapsed(), band.choice()]).toEqual([false, "open"]);
    // Resized where it opened open by default, with nothing chosen yet.
    const resized = await open(bandDefault("open"));
    await resized.key("ArrowDown");
    expect([resized.collapsed(), resized.choice()]).toEqual([false, "open"]);
  });

  it("never keeps a run's opening: with nothing chosen, the next canvas opens as the default says", async () => {
    const band = await open(bandDefault("closed"));
    await band.render(bandDefault("closed"), "run-1");
    expect([band.collapsed(), band.choice()]).toEqual([false, null]);
    expect([...band.storage.kept.keys()]).toEqual([]);
    await band.reopen();
    expect(band.collapsed()).toBe(true);
  });

  it("keeps the person's closing when a run opens the band afterwards", async () => {
    const band = await open(bandDefault("open"));
    await band.key("Home");
    await band.render(bandDefault("open"), "run-1");
    expect([band.collapsed(), band.choice()]).toEqual([false, "closed"]);
    await band.reopen();
    expect(band.collapsed()).toBe(true);
  });

  it("opens the next canvas's band as the person opened it", async () => {
    const band = await open(bandDefault("closed"));
    await band.pressBar();
    await band.reopen();
    expect([band.collapsed(), band.choice()]).toEqual([false, "open"]);
  });

  it("stays as it opened when the page hands down another default while the canvas is open", async () => {
    const band = await open(bandDefault("open"));
    await band.render(bandDefault("closed"));
    expect([band.collapsed(), band.choice()]).toEqual([false, null]);
  });
});
