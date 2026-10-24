import { act, type Ref } from "react";
import { coveredWidth } from "@/lib/pictures/shapes";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapOverview } from "./api";
import { HostElement, HostEvent, installDomHost } from "./testing/dom-host";
import { MapStrip } from "./MapStrip";

/**
 * A map's card picture is asked for by the listing's picture version, and
 * only when the listing says the reader is served one: a map with none
 * draws the chart-paper placeholder and sends no request, so no answer can
 * fail. While newer work waits or has failed, the last picture stays; a
 * picture that fails to load leaves the placeholder; a toggle of the theme
 * asks for the same version in the other theme, and a map's edit that
 * leaves the version alone asks for nothing new.
 */

vi.mock("./gallery-icons", async (original) => ({ ...await original<object>(), MapPlaceholder: ({ ref }: { ref?: Ref<HTMLElement> }) => <i ref={ref} data-placeholder="" /> }));
const look = vi.hoisted(() => ({ theme: "light" as "light" | "dark" }));
vi.mock("./theme", () => ({ useTheme: () => ({ theme: look.theme }) }));

const AT = "2026-10-02T14:00:00Z";
type Picture = Pick<MapOverview, "pictureState" | "pictureVersion" | "hasThumbnail"> & { updatedAt?: string };
const map = (picture: Picture) => ({ id: "m", name: "Depot", updatedAt: AT, ...picture }) as unknown as MapOverview;
const address = (version: string, theme = "light") => `/api/maps/m/thumbnail?v=${encodeURIComponent(version)}&theme=${theme}`;

let host: ReturnType<typeof installDomHost>;
let container: HostElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  look.theme = "light";
  host = installDomHost();
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
});

async function draw(picture: Picture) {
  await act(async () => root.render(<MapStrip map={map(picture)} />));
}
const placeholders = () => container.querySelectorAll("[data-placeholder]");
const requested = () => container.querySelectorAll("img").map((img) => img.getAttribute("src"));

describe("a map's card picture", () => {
  it.each([
    ["waiting for its first picture", { pictureState: "waiting", pictureVersion: null, hasThumbnail: false }],
    ["whose last attempt failed with no picture before it", { pictureState: "failed", pictureVersion: null, hasThumbnail: false }],
    ["the renderer cannot draw yet", { pictureState: "unsupported", pictureVersion: null, hasThumbnail: false }],
    ["on an instance with no renderer", { pictureState: "unavailable", pictureVersion: null, hasThumbnail: false }],
    ["whose picture the reader is not served", { pictureState: "current", pictureVersion: null, hasThumbnail: false }],
  ] as const)("with none, %s, draws only the placeholder and asks for nothing", async (_, picture) => {
    await draw(picture);
    expect(placeholders()).toHaveLength(1);
    expect(requested()).toEqual([]);
  });

  it.each([
    ["current", "current"],
    ["while newer work waits", "waiting"],
    ["while newer work has failed", "failed"],
    ["while the renderer cannot draw a newer state", "unsupported"],
    ["while the instance has no renderer", "unavailable"],
  ] as const)("served one, shows it %s, by its version, over the placeholder", async (_, pictureState) => {
    await draw({ pictureState, pictureVersion: "server-3", hasThumbnail: true });
    expect(placeholders()).toHaveLength(1);
    expect(requested()).toEqual([address("server-3")]);
  });

  it("asks for a new picture's address as soon as the listing names a new version, and for none on an edit that keeps it", async () => {
    await draw({ pictureState: "waiting", pictureVersion: "server-3", hasThumbnail: true });
    await draw({ pictureState: "waiting", pictureVersion: "server-3", hasThumbnail: true, updatedAt: "2026-10-02T15:00:00Z" });
    expect(requested()).toEqual([address("server-3")]);
    await draw({ pictureState: "current", pictureVersion: "server-4", hasThumbnail: true });
    expect(requested()).toEqual([address("server-4")]);
  });

  it("leaves the placeholder when the picture fails to load, and asks again for a new version", async () => {
    await draw({ pictureState: "current", pictureVersion: "server-3", hasThumbnail: true });
    await act(async () => { container.querySelector("img")!.dispatchEvent(new HostEvent("error")); });
    expect(requested()).toEqual([]);
    expect(placeholders()).toHaveLength(1);
    await draw({ pictureState: "current", pictureVersion: "server-4", hasThumbnail: true });
    expect(requested()).toEqual([address("server-4")]);
  });

  it("follows a theme toggle with the same version, and a failure in one theme strands nothing in the other", async () => {
    await draw({ pictureState: "current", pictureVersion: "server-3", hasThumbnail: true });
    look.theme = "dark";
    await draw({ pictureState: "current", pictureVersion: "server-3", hasThumbnail: true });
    expect(requested()).toEqual([address("server-3", "dark")]);
    await act(async () => { container.querySelector("img")!.dispatchEvent(new HostEvent("error")); });
    expect(requested()).toEqual([]);
    look.theme = "light";
    await draw({ pictureState: "current", pictureVersion: "server-3", hasThumbnail: true });
    expect(requested()).toEqual([address("server-3")]);
  });
});

/** A host box the strip can measure, and the observer a browser would run on its resize. */
function measured(box: { width: number; height: number }) {
  const size = { ...box };
  const observers: (() => void)[] = [];
  Object.assign(container, { getBoundingClientRect: () => ({ ...size, x: 0, y: 0, top: 0, left: 0, right: size.width, bottom: size.height }) });
  vi.stubGlobal("ResizeObserver", class { constructor(private readonly react: () => void) {} observe() { observers.push(this.react); } disconnect() { observers.splice(observers.indexOf(this.react), 1); } });
  return { resize: async (next: { width: number; height: number }) => { Object.assign(size, next); await act(async () => { for (const react of [...observers]) react(); }); } };
}
// The kept widths, written out: the narrowest a phone's card needs up to
// the master that covers the widest box at three density.
const KEPT = [360, 720, 1080, 1440, 1980, 2904];
const offered = (theme = "light") => KEPT.map((width) => `${address("server-3", theme)}&shape=card&width=${width} ${width}w`).join(", ");
const image = () => container.querySelector("img")!;
// The test host keeps an attribute's name as React wrote it; a browser lowercases it.
const srcset = () => image().getAttribute("srcSet") ?? image().getAttribute("srcset");

describe("a measured strip", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it.each([
    ["a Maps card", { width: 346, height: 148 }],
    ["Continue beside Start, at its narrowest", { width: 592, height: 300 }],
    ["Continue beside Start, at its widest", { width: 912, height: 300 }],
    ["a band", { width: 1100, height: 280 }],
  ] as const)("offers %s the one shape's kept sizes, with the box's own width", async (_, box) => {
    measured(box);
    await draw({ pictureState: "current", pictureVersion: "server-3", hasThumbnail: true });
    expect(srcset()).toBe(offered());
    // None of these is narrower than the picture's proportion, so the picture covers exactly the box's width.
    expect(image().getAttribute("sizes")).toBe(`${box.width}px`);
    expect(image().getAttribute("src")).toBe(address("server-3"));
  });

  it("gives a box taller than the picture the wider width the cropped picture covers", async () => {
    const box = { width: 200, height: 150 };
    measured(box);
    await draw({ pictureState: "current", pictureVersion: "server-3", hasThumbnail: true });
    const covered = Math.ceil(coveredWidth(box));
    expect(covered).toBe(Math.ceil((150 * 968) / 494));
    expect(covered).toBeGreaterThan(box.width);
    expect(image().getAttribute("sizes")).toBe(`${covered}px`);
  });

  it("measures again on a resize and follows the theme", async () => {
    const strip = measured({ width: 300, height: 128 });
    await draw({ pictureState: "current", pictureVersion: "server-3", hasThumbnail: true });
    expect(image().getAttribute("sizes")).toBe("300px");
    await strip.resize({ width: 900, height: 200 });
    expect(srcset()).toBe(offered());
    expect(image().getAttribute("sizes")).toBe("900px");
    look.theme = "dark";
    await draw({ pictureState: "current", pictureVersion: "server-3", hasThumbnail: true });
    expect(srcset()).toBe(offered("dark"));
  });

  it("asks for the default picture where the box has no size yet, and the sizes once it has", async () => {
    const strip = measured({ width: 0, height: 0 });
    await draw({ pictureState: "current", pictureVersion: "server-3", hasThumbnail: true });
    expect(srcset()).toBeNull();
    expect(image().getAttribute("src")).toBe(address("server-3"));
    await strip.resize({ width: 300, height: 128 });
    expect(srcset()).toBe(offered());
  });

  it("leaves the placeholder when a size fails to load, and asks again for a new version", async () => {
    measured({ width: 300, height: 128 });
    await draw({ pictureState: "current", pictureVersion: "server-3", hasThumbnail: true });
    await act(async () => { image().dispatchEvent(new HostEvent("error")); });
    expect(container.querySelector("img")).toBeNull();
    await draw({ pictureState: "current", pictureVersion: "server-4", hasThumbnail: true });
    expect(srcset()).toContain("v=server-4");
  });
});

/**
 * The strip's fade stands over the placeholder and leaves a map's picture
 * once the browser has drawn it: the image is marked on its load, a new
 * address waits for its own, and a picture that fails leaves the
 * placeholder under the fade.
 */
describe("the fade over a map's picture", () => {
  const drawn = () => image().hasAttribute("data-loaded");
  const load = async () => { await act(async () => { image().dispatchEvent(new HostEvent("load")); }); };
  const current = (version: string) => ({ pictureState: "current", pictureVersion: version, hasThumbnail: true }) as const;
  afterEach(() => { vi.unstubAllGlobals(); });

  it("stands while the picture is on its way, through later listings, and leaves once it is drawn", async () => {
    measured({ width: 346, height: 148 });
    await draw(current("server-3"));
    expect(drawn()).toBe(false);
    await draw({ ...current("server-3"), updatedAt: "2026-10-02T15:00:00Z" });
    expect(drawn()).toBe(false);
    await load();
    expect(drawn()).toBe(true);
    // A resize offers the same sizes: the drawn picture stays drawn.
    await draw({ ...current("server-3"), updatedAt: "2026-10-02T16:00:00Z" });
    expect(drawn()).toBe(true);
  });

  it("comes back for a new version and for the other theme until that picture is drawn", async () => {
    await draw(current("server-3"));
    await load();
    await draw(current("server-4"));
    expect(requested()).toEqual([address("server-4")]);
    expect(drawn()).toBe(false);
    await load();
    expect(drawn()).toBe(true);
    look.theme = "dark";
    await draw(current("server-4"));
    expect(requested()).toEqual([address("server-4", "dark")]);
    expect(drawn()).toBe(false);
    await load();
    expect(drawn()).toBe(true);
  });

  it("stays over the placeholder when the picture fails to load, drawn or not before", async () => {
    await draw(current("server-3"));
    await act(async () => { image().dispatchEvent(new HostEvent("error")); });
    expect(container.querySelector("img")).toBeNull();
    expect(placeholders()).toHaveLength(1);
    await draw(current("server-4"));
    await load();
    await draw(current("server-5"));
    await act(async () => { image().dispatchEvent(new HostEvent("error")); });
    expect(container.querySelector("img")).toBeNull();
  });

  it("leaves at once over a picture the browser already holds whole", async () => {
    const whole = { complete: { configurable: true, get(this: HostElement) { return this.tagName === "IMG"; } }, naturalWidth: { configurable: true, get(this: HostElement) { return this.tagName === "IMG" ? 692 : 0; } } };
    Object.defineProperties(HostElement.prototype, whole);
    try {
      await draw(current("server-3"));
      expect(drawn()).toBe(true);
    } finally {
      for (const name of Object.keys(whole)) delete (HostElement.prototype as unknown as Record<string, unknown>)[name];
    }
  });
});
