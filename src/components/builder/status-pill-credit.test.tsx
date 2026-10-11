import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createStatusChannel } from "@/lib/map-status";
import { HostElement, installDomHost } from "../testing/dom-host";
import { StatusBar } from "./StatusBar";
import { CREDIT_DAYLIGHT, creditClearance } from "./use-status-priority";

/**
 * The status pill and the basemap credit share the stage's bottom band:
 * the pill centred, the credit in the lower-right corner. Nothing may draw
 * the pill over the credit, at any stage width. The host computes no
 * layout, so the geometry is laid out here from the live stylesheets (the
 * pill's band, padding, gap, width cap and its transform; the credit's
 * corner) with the widths a stage holds: the pill's readouts as a builder
 * replica measured them (about 417 px at rest) and a 244 px credit. The
 * pill's drawn box is then measured against the credit's.
 */

const PILL_CSS = readFileSync("src/components/builder/StatusBar.module.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const STAGE_CSS = readFileSync("src/components/builder/MapBuilder.module.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (css: string, selector: string) => {
  const match = new RegExp(`(?:^|\\n)${selector.replace(".", "\\.")}\\s*{([^}]*)}`).exec(css);
  expect(match, `${selector} not found where this check expects it`).not.toBeNull();
  return match![1];
};
const px = (body: string, property: string) => {
  const match = new RegExp(`(?:^|[;\\s])${property}:\\s*(\\d+(?:\\.\\d+)?)px`).exec(body);
  expect(match, `${property} not found where this check expects it`).not.toBeNull();
  return Number(match![1]);
};
const BAR = rule(PILL_CSS, ".bar");
const CREDIT = rule(STAGE_CSS, ".mapCredit");
const PILL = {
  bottom: px(BAR, "bottom"), height: px(BAR, "height"), gap: px(BAR, "gap"),
  padding: Number(/padding:\s*0\s+(\d+)px/.exec(BAR)![1]),
  /** The width cap's margin: `max-width: calc(100% - Npx)`. */
  capMargin: Number(/max-width:\s*calc\(100%\s*-\s*(\d+)px\)/.exec(BAR)![1]),
  transform: /transform:\s*([^;]+);/.exec(BAR)![1].trim(),
};
const CORNER = { right: px(CREDIT, "right"), bottom: px(CREDIT, "bottom") };
/** One 11 px line of credit text. */
const CREDIT_LINE = 14;
const CREDIT_WIDTH = 244;
/** The readouts at rest, as the replica measured them: 417 px with the gaps and padding. */
const READOUT: Record<string, number> = { Coords: 110, Zoom: 64, BBox: 185, Records: 96, Pitch: 58 };
const STAGE_HEIGHT = 700;

/** The pill's horizontal offset from its `left: 50%`, as its transform reads it. */
function drawnOffset(width: number, shift: string): number {
  if (PILL.transform === "translateX(-50%)") return -width / 2;
  const variable = /^translateX\(calc\(-50%\s*-\s*var\((--[\w-]+)(?:,\s*0(?:px)?)?\)\)\)$/.exec(PILL.transform);
  expect(variable, `the pill's transform reads ${PILL.transform}`).not.toBeNull();
  return -width / 2 - (parseFloat(shift) || 0);
}

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** The pill laid out on a stage `width` wide beside a credit, as drawn. */
async function layOut(width: number) {
  const host = installDomHost();
  vi.stubGlobal("HTMLElement", HostElement);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const center = width / 2;
  const cap = width - PILL.capMargin;
  const band = { top: STAGE_HEIGHT - PILL.bottom - PILL.height, bottom: STAGE_HEIGHT - PILL.bottom };
  const creditBox = { left: width - CORNER.right - CREDIT_WIDTH, right: width - CORNER.right,
    top: STAGE_HEIGHT - CORNER.bottom - CREDIT_LINE, bottom: STAGE_HEIGHT - CORNER.bottom };
  const box = (left: number, right: number, top: number, bottom: number) =>
    ({ left, right, top, bottom, width: right - left, height: bottom - top, x: left, y: top });
  const isProbe = (element: HostElement) => /(^|\s)_probe_/.test(element.getAttribute("class") ?? "");
  Object.assign(host.window, { setTimeout, clearTimeout,
    getComputedStyle: () => ({ paddingLeft: `${PILL.padding}px`, paddingRight: `${PILL.padding}px`, columnGap: `${PILL.gap}px` }),
  });
  Object.defineProperty(HostElement.prototype, "clientWidth", { configurable: true, get(this: HostElement) { return isProbe(this) ? cap : 0; } });
  (HostElement.prototype as unknown as { getBoundingClientRect: () => object }).getBoundingClientRect = function (this: HostElement) {
    if (this.hasAttribute("data-map-credit")) return box(creditBox.left, creditBox.right, creditBox.top, creditBox.bottom);
    if (isProbe(this)) return box(center - cap / 2, center + cap / 2, band.top, band.bottom);
    const parent = this.parentElement;
    if (parent && isProbe(parent)) {
      const key = Object.keys(READOUT).find(name => this.textContent.startsWith(name));
      return box(0, key ? READOUT[key] : 0, band.top, band.bottom);
    }
    return box(0, 0, 0, 0);
  };
  cleanups.push(() => {
    delete (HostElement.prototype as unknown as Record<string, unknown>).getBoundingClientRect;
    delete (HostElement.prototype as unknown as Record<string, unknown>).clientWidth;
  });
  const credit = host.document.createElement("div");
  credit.setAttribute("data-map-credit", "");
  host.document.body.appendChild(credit);
  const container = host.document.createElement("div");
  host.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  cleanups.push(() => { act(() => root.unmount()); host.uninstall(); });
  const props = { channel: createStatusChannel(), credit: credit as unknown as HTMLElement };
  await act(async () => root.render(<StatusBar {...props} />));
  const bar = host.document.querySelector("[data-status-bar]");
  if (!bar) return { bar: null, credit: creditBox, center };
  const shown = bar.children.map(child => Object.keys(READOUT).find(name => child.textContent.startsWith(name))!);
  const pillWidth = shown.reduce((sum, key) => sum + READOUT[key], 0) + PILL.gap * (shown.length - 1) + 2 * PILL.padding;
  const left = center + drawnOffset(pillWidth, bar.style.getPropertyValue("--pill-shift"));
  return { bar: { left, right: left + pillWidth, top: band.top, bottom: band.bottom, shown }, credit: creditBox, center };
}

it("measures the replica's resting pill at the width it reported", () => {
  expect(READOUT.Coords + READOUT.Zoom + READOUT.BBox + 2 * PILL.gap + 2 * PILL.padding).toBe(417);
});

it.each([1600, 1200, 940, 900, 820, 760, 680, 600, 520, 440])("keeps the pill off the credit on a stage %i px wide", async width => {
  const { bar, credit } = await layOut(width);
  if (!bar) {
    // No pill at all: only where not even the coordinates fit left of the credit.
    expect(credit.left - CREDIT_DAYLIGHT - PILL.capMargin / 2).toBeLessThan(READOUT.Coords + 2 * PILL.padding);
    return;
  }
  // The two share the bottom band, so they may not share a column.
  expect(bar.top < credit.bottom && credit.top < bar.bottom).toBe(true);
  expect(bar.right, `the pill ends at ${bar.right}, the credit starts at ${credit.left}`).toBeLessThanOrEqual(credit.left);
  // Nor may the pill leave the stage's edge for it.
  expect(bar.left).toBeGreaterThanOrEqual(PILL.capMargin / 2);
});

it("leaves the pill centred where the stage has room for both", async () => {
  const { bar, center } = await layOut(1600);
  expect(bar!.shown).toEqual(["Coords", "Zoom", "BBox"]);
  expect((bar!.left + bar!.right) / 2).toBe(center);
});

it("keeps every readout on a stage the replica showed the pill over the credit at", async () => {
  const { bar, credit } = await layOut(900);
  expect(bar!.shown).toEqual(["Coords", "Zoom", "BBox"]);
  expect(bar!.right).toBeLessThanOrEqual(credit.left);
});

it("leaves the pill where it is while the credit is out of its band", () => {
  const probe = { left: 65, right: 835, top: 652, bottom: 684 };
  expect(creditClearance(probe, { left: 640, right: 884, top: 620, bottom: 634 }, 417)).toEqual({ room: Infinity, shift: 0 });
  expect(creditClearance(probe, null, 417)).toEqual({ room: Infinity, shift: 0 });
  // In the band, the slide keeps the daylight and the room ends there.
  expect(creditClearance(probe, { left: 640, right: 884, top: 674, bottom: 688 }, 417)).toEqual({ room: 640 - CREDIT_DAYLIGHT - 65, shift: 450 + 208.5 - (640 - CREDIT_DAYLIGHT) });
});
