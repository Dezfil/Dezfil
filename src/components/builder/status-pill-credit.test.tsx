import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createStatusChannel } from "@/lib/map-status";
import { HostElement, HostEvent, installDomHost } from "../testing/dom-host";
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
 *
 * A legend card in the lower-left corner shares the same band from the
 * other side. Where the credit is short, the pill would keep its bounding
 * box and widen over the legend's last row; it keeps clear of the card as
 * it keeps clear of the credit.
 */

const PILL_CSS = readFileSync("src/components/builder/StatusBar.module.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const STAGE_CSS = readFileSync("src/components/builder/MapBuilder.module.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (css: string, selector: string) => {
  const match = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*{([^}]*)}`).exec(css);
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
const LEGEND_CORNER = rule(STAGE_CSS, '.overlayCorner[data-corner="bottom-left"]');
const LEGEND_AT = { left: px(LEGEND_CORNER, "left"), bottom: px(LEGEND_CORNER, "bottom") };
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

/** A legend card at its widest (the fitter's 240 px base), two classes tall. */
const LEGEND = { width: 240, height: 80 };
/** A one-line credit about as short as a built-in basemap's. */
const SHORT_CREDIT = 160;

/** The pill laid out on a stage `width` wide beside a credit, as drawn,
 * with a legend card in the lower-left corner when one is given. */
async function layOut(width: number, { creditWidth = CREDIT_WIDTH, legend = null }: {
  creditWidth?: number; legend?: { width: number; height: number } | null;
} = {}) {
  const host = installDomHost();
  vi.stubGlobal("HTMLElement", HostElement);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const center = width / 2;
  const cap = width - PILL.capMargin;
  const band = { top: STAGE_HEIGHT - PILL.bottom - PILL.height, bottom: STAGE_HEIGHT - PILL.bottom };
  const creditBox = { left: width - CORNER.right - creditWidth, right: width - CORNER.right,
    top: STAGE_HEIGHT - CORNER.bottom - CREDIT_LINE, bottom: STAGE_HEIGHT - CORNER.bottom };
  // Mutable, so a test can move the card and ask the pill to look again.
  const legendBox = legend && { left: LEGEND_AT.left, right: LEGEND_AT.left + legend.width,
    top: STAGE_HEIGHT - LEGEND_AT.bottom - legend.height, bottom: STAGE_HEIGHT - LEGEND_AT.bottom };
  const box = (left: number, right: number, top: number, bottom: number) =>
    ({ left, right, top, bottom, width: right - left, height: bottom - top, x: left, y: top });
  const isProbe = (element: HostElement) => /(^|\s)_probe_/.test(element.getAttribute("class") ?? "");
  Object.assign(host.window, { setTimeout, clearTimeout,
    getComputedStyle: () => ({ paddingLeft: `${PILL.padding}px`, paddingRight: `${PILL.padding}px`, columnGap: `${PILL.gap}px` }),
  });
  Object.defineProperty(HostElement.prototype, "clientWidth", { configurable: true, get(this: HostElement) { return isProbe(this) ? cap : 0; } });
  (HostElement.prototype as unknown as { getBoundingClientRect: () => object }).getBoundingClientRect = function (this: HostElement) {
    if (this.hasAttribute("data-map-credit")) return box(creditBox.left, creditBox.right, creditBox.top, creditBox.bottom);
    if (legendBox && this.getAttribute("data-corner") === "bottom-left") return box(legendBox.left, legendBox.right, legendBox.top, legendBox.bottom);
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
  const corner = host.document.createElement("div");
  corner.setAttribute("data-corner", "bottom-left");
  host.document.body.appendChild(corner);
  const container = host.document.createElement("div");
  host.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  cleanups.push(() => { act(() => root.unmount()); host.uninstall(); });
  const props = { channel: createStatusChannel(), credit: credit as unknown as HTMLElement,
    legend: legendBox ? corner as unknown as HTMLElement : null };
  await act(async () => root.render(<StatusBar {...props} />));
  const drawn = () => {
    const bar = host.document.querySelector("[data-status-bar]");
    if (!bar) return null;
    const shown = bar.children.map(child => Object.keys(READOUT).find(name => child.textContent.startsWith(name))!);
    const pillWidth = shown.reduce((sum, key) => sum + READOUT[key], 0) + PILL.gap * (shown.length - 1) + 2 * PILL.padding;
    const left = center + drawnOffset(pillWidth, bar.style.getPropertyValue("--pill-shift"));
    return { left, right: left + pillWidth, top: band.top, bottom: band.bottom, shown };
  };
  /** The card glides to `left` and its transition ends. */
  const glideLegend = async (left: number) => {
    legendBox!.right += left - legendBox!.left;
    legendBox!.left = left;
    await act(async () => { corner.dispatchEvent(new HostEvent("transitionend", { bubbles: true })); });
    return drawn();
  };
  return { bar: drawn(), credit: creditBox, legend: legendBox, center, glideLegend };
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

it("keeps every readout beside a short credit while no legend shares the band", async () => {
  const { bar, credit, center } = await layOut(820, { creditWidth: SHORT_CREDIT });
  expect(bar!.shown).toEqual(["Coords", "Zoom", "BBox"]);
  expect((bar!.left + bar!.right) / 2).toBe(center);
  expect(bar!.right).toBeLessThanOrEqual(credit.left - CREDIT_DAYLIGHT);
});

it("drops the bounding box rather than cover a lower-left legend beside a short credit", async () => {
  const { bar, credit, legend } = await layOut(820, { creditWidth: SHORT_CREDIT, legend: LEGEND });
  expect(bar!.shown).toEqual(["Coords", "Zoom"]);
  expect(bar!.left, `the pill starts at ${bar!.left}, the legend ends at ${legend!.right}`).toBeGreaterThanOrEqual(legend!.right + CREDIT_DAYLIGHT);
  expect(bar!.right).toBeLessThanOrEqual(credit.left - CREDIT_DAYLIGHT);
});

it.each([1600, 1200, 940, 900, 820, 760, 680, 600])("keeps the pill between a lower-left legend and a short credit on a stage %i px wide", async width => {
  const { bar, credit, legend } = await layOut(width, { creditWidth: SHORT_CREDIT, legend: LEGEND });
  const start = legend!.right + CREDIT_DAYLIGHT;
  const end = credit.left - CREDIT_DAYLIGHT;
  if (!bar) {
    // No pill at all: only where not even the coordinates fit between the two.
    expect(end - start).toBeLessThan(READOUT.Coords + 2 * PILL.padding);
    return;
  }
  expect(bar.left, `the pill starts at ${bar.left}, the legend ends at ${legend!.right}`).toBeGreaterThanOrEqual(start);
  expect(bar.right, `the pill ends at ${bar.right}, the credit starts at ${credit.left}`).toBeLessThanOrEqual(end);
  // Nor may the pill leave its width cap for either of them.
  expect(bar.left).toBeGreaterThanOrEqual(PILL.capMargin / 2);
  expect(bar.right).toBeLessThanOrEqual(width - PILL.capMargin / 2);
});

it("looks again when the legend glides into the pill's way", async () => {
  // Fullscreen moves the lower-left corner past the floating inspector;
  // the card glides there, and nothing resizes on the way.
  const { bar, credit, glideLegend } = await layOut(1200, { creditWidth: SHORT_CREDIT, legend: LEGEND });
  expect(bar!.shown).toEqual(["Coords", "Zoom", "BBox"]);
  const moved = await glideLegend(300);
  expect(moved!.shown).toEqual(["Coords", "Zoom", "BBox"]);
  expect(moved!.left).toBeGreaterThanOrEqual(300 + LEGEND.width + CREDIT_DAYLIGHT);
  expect(moved!.right).toBeLessThanOrEqual(credit.left - CREDIT_DAYLIGHT);
});

it("gives the pill its band back while the legend is out of it", () => {
  const probe = { left: 65, right: 835, top: 652, bottom: 684 };
  const credit = { left: 640, right: 884, top: 674, bottom: 688 };
  // Lifted over a docked timeline, the card stands above the band.
  const lifted = { left: 16, right: 256, top: 438, bottom: 518 };
  expect(creditClearance(probe, credit, 417, lifted)).toEqual(creditClearance(probe, credit, 417));
  expect(creditClearance(probe, null, 417, lifted)).toEqual({ room: Infinity, shift: 0 });
  // Grounded with no credit beside it, the room runs from the card's
  // daylight to the cap, and the pill slides right just clear of it.
  const grounded = { left: 16, right: 256, top: 604, bottom: 684 };
  const start = 256 + CREDIT_DAYLIGHT;
  expect(creditClearance(probe, null, 417, grounded)).toEqual({ room: 835 - start, shift: -(start - (450 - 208.5)) });
});
