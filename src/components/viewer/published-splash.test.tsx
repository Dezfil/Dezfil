import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASEMAPS } from "@/lib/basemap";
import { HostElement, installDomHost } from "../testing/dom-host";
import { wire } from "../workflow-canvas/fetch-wire";
import { BANDS, MARK_D } from "../logo-mark-geometry";
import { PublishedView } from "./PublishedView";

/**
 * The published reader before it has a map: while the view loads, the
 * icon shimmers beside "Loading map…" with no spin of its own; an address
 * that resolves to nothing shows the still icon above "Map not found".
 */

vi.mock("next/dynamic", () => ({ default: () => function Canvas() { return null; } }));

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.unstubAllGlobals();
});

const drain = async () => {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
};

async function open() {
  const host = installDomHost();
  Object.assign(host.window, {
    setInterval, clearInterval, setTimeout, clearTimeout,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  vi.stubGlobal("HTMLElement", HostElement);
  const w = wire(); vi.stubGlobal("fetch", w.fetch);
  const page = host.document.createElement("div");
  host.document.body.appendChild(page);
  const root = createRoot(page as unknown as Element);
  cleanups.push(() => { act(() => root.unmount()); host.uninstall(); });
  await act(async () => { root.render(<PublishedView token="tok" basemapUrl={BASEMAPS[0].url} basemaps={BASEMAPS} />); await drain(); });
  return { page, read: () => w.calls.find((c) => c.path === "/api/published/tok")!, step: (work: () => void) => act(async () => { work(); await drain(); }) };
}

describe("the published reader's splash", () => {
  it("shimmers the icon beside the loading line, unwrapped", async () => {
    const { page } = await open();
    expect(page.textContent).toContain("Loading map…");
    const mark = page.querySelector("svg") as HostElement;
    expect(mark.getAttribute("aria-label")).toBe("Loading");
    expect(mark.querySelectorAll("path").map((p) => p.getAttribute("d"))).toEqual([...BANDS]);
    // The icon sits straight in the splash: nothing turns it.
    expect((mark.parentElement as HostElement).className).toMatch(/splash/);
  });

  it("shows the still icon on an address that resolves to nothing", async () => {
    const { page, read, step } = await open();
    await step(() => read().refuse(404, "not_found", "Not found."));
    expect(page.querySelector("h1")?.textContent).toBe("Map not found");
    const mark = page.querySelector("svg") as HostElement;
    expect(mark.getAttribute("aria-label")).toBe("Dezfil");
    expect(mark.querySelectorAll("path").map((p) => p.getAttribute("d"))).toEqual([MARK_D]);
  });
});
