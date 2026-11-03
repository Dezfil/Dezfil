import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostElement, installDomHost } from "@/components/testing/dom-host";
import { distributionEdges, type ClassificationDistribution } from "@/lib/classification-distribution";
import { toHex } from "@/lib/style/color";
import { niceBreaks } from "@/lib/style/nice-breaks";
import type { QuantileFill } from "@/lib/style/style";
import { BreakBrush } from "./BreakBrush";
import { barValue, brushAxis, classIndex, handleLanes, snapWhole } from "./brush-axis";

/**
 * The classed histogram on the axis the statistics read answered. On the
 * collisions shape (1,239 skewed counts from 1 to 73) it is logarithmic:
 * bars, colour strip and handles place values through one mapping, the
 * bars take their colours from the bins' own edges, and the handles for 1,
 * 2 and 3 stand apart, each its own control. Seeded defects, each failing
 * here before this brush: handles placed linearly over the extent (1, 2
 * and 3 within 3% of the track's left end), bars coloured by their linear
 * centres (the bar of the 1s painted as the class of 2), and a whole-number
 * release that rounded without keeping the order.
 */

let host: ReturnType<typeof installDomHost>;
let container: HostElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  host = installDomHost();
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
});

const COLLISIONS = [
  ...new Array(736).fill(1),
  ...new Array(194).fill(2),
  ...new Array(68).fill(3),
  ...Array.from({ length: 241 }, (_, k) => 4 + Math.floor(69 * (k / 240) ** 3)),
];

function distribution(values: number[], axis: "linear" | "log", wholeNumbers: boolean) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const edges = distributionEdges(min, max, axis);
  const inner = edges.slice(1, -1);
  const bins = new Array<number>(edges.length - 1).fill(0);
  for (const v of values) bins[inner.filter((e) => v >= e).length] += 1;
  const stats: ClassificationDistribution & { min: number; max: number } = {
    field: "v", kind: "numeric", numeric: true, min, max,
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    bins, distribution: "classification", axis, edges, wholeNumbers,
  };
  return stats;
}
const collisions = distribution(COLLISIONS, "log", true);

function paint(breaks: number[]): QuantileFill {
  return {
    type: "quantile", attribute: "value", palette: "global_warming", method: "quantile", breaks,
    colors: Array.from({ length: breaks.length + 1 }, (_, i) => ({ r: 60 * i, g: 20, b: 200 - 40 * i, a: 1 })),
    wholeNumbers: true,
  };
}

function render(p: QuantileFill, stats = collisions, handlers: { onPaintPreview?: (p: QuantileFill) => void; onPaintCommit?: (p: QuantileFill) => Promise<boolean> } = {}) {
  const onPaintPreview = handlers.onPaintPreview ?? vi.fn();
  const onPaintCommit = handlers.onPaintCommit ?? vi.fn(async () => true);
  act(() => root.render(
    <BreakBrush paint={p} stats={stats} disabled={false} onPaint={() => {}} onPaintPreview={onPaintPreview} onPaintCommit={onPaintCommit} />,
  ));
  return { onPaintPreview, onPaintCommit };
}

const handles = () => container.querySelectorAll("input");
const props = (el: HostElement) => {
  const key = Object.keys(el).find((name) => name.startsWith("__reactProps$"))!;
  return (el as unknown as Record<string, Record<string, (e: unknown) => void>>)[key];
};
/** Drag one handle to a value and let go: down, moves, up. */
async function drag(index: number, ...values: number[]) {
  const axis = brushAxis(collisionsOr.min, collisionsOr.max, collisionsOr.axis);
  act(() => props(handles()[index]).onPointerDown({}));
  for (const v of values) act(() => props(handles()[index]).onChange({ target: { value: String(axis.position(v) * 1000) } }));
  await act(async () => props(handles()[index]).onPointerUp({}));
}
let collisionsOr = collisions;

describe("the classed histogram on its answered axis", () => {
  beforeEach(() => { collisionsOr = collisions; });

  it("places the handles for 1, 2 and 3 apart on the log axis, as their values", () => {
    render(paint([1, 2, 3]));
    const at = handles().map((h) => Number(h.value) / 1000);
    expect(at[0]).toBe(0);
    expect(at[1]).toBeCloseTo(Math.log(2) / Math.log(73), 3);
    expect(at[2]).toBeCloseTo(Math.log(3) / Math.log(73), 3);
    // Linearly over 1 to 73 all three would sit within 3% of the left end.
    expect(at[2] - at[0]).toBeGreaterThan(0.2);
    expect(handles().map((h) => h.getAttribute("aria-valuetext"))).toEqual(["1", "2", "3"]);
    expect(handles().map((h) => h.getAttribute("aria-label"))).toEqual(["Class boundary 1", "Class boundary 2", "Class boundary 3"]);
  });

  it("draws the colour strip on the same mapping", () => {
    const p = paint([1, 2, 3]);
    render(p);
    const strip = container.querySelectorAll("div").find((d) => d.children.length === 4 && d.children.every((c) => c.tagName === "I"))!;
    const widths = strip.children.map((c) => parseFloat(String(c.style.width)) / 100);
    const axis = brushAxis(1, 73, "log");
    expect(widths[0]).toBeCloseTo(0, 6);
    expect(widths[1]).toBeCloseTo(axis.position(2), 6);
    expect(widths[2]).toBeCloseTo(axis.position(3) - axis.position(2), 6);
    expect(widths[3]).toBeCloseTo(1 - axis.position(3), 6);
  });

  it("colours each bar from its own edges: the bars of 1, 2, 3 and 4 in their four classes", () => {
    const p = paint([1, 2, 3]);
    render(p);
    const bars = container.querySelectorAll("i").filter((i) => i.style.height !== undefined && i.parentElement?.children.length === collisions.bins.length);
    expect(bars).toHaveLength(collisions.bins.length);
    const binOf = (v: number) => collisions.edges.slice(1, -1).filter((e) => v >= e).length;
    for (const [v, cls] of [[1, 0], [2, 1], [3, 2], [4, 3], [73, 3]] as const) {
      expect(bars[binOf(v)].style.background, `the bar holding ${v}`).toBe(toHex(p.colors[cls]));
    }
  });

  it("moves one handle on its own and saves one Custom edit when the drag ends", async () => {
    const { onPaintPreview, onPaintCommit } = render(paint([1, 5, 9]));
    await drag(1, 5.5, 6.1, 6.4);
    expect(onPaintPreview).toHaveBeenCalledTimes(3);
    expect(onPaintCommit).toHaveBeenCalledTimes(1);
    const saved = (onPaintCommit as ReturnType<typeof vi.fn>).mock.calls[0][0] as QuantileFill;
    expect(saved.breaks).toEqual([1, 6, 9]);
    expect(saved.method).toBe("custom");
    expect(saved.baseMethod).toBe("quantile");
    expect(saved.wholeNumbers).toBe(true);
  });

  it("stays put on whole numbers when no whole number fits between the neighbours", async () => {
    const p = paint([1, 2, 3]);
    const { onPaintCommit } = render(p);
    await drag(1, 2.4);
    expect((onPaintCommit as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(p);
  });

  it("staggers crowded grips at the upper end, each tied to its true place", () => {
    render(paint([70, 71, 72]));
    const lanes = handles().map((h) => h.parentElement!.getAttribute("data-lane"));
    expect(lanes).toEqual(["up", "down", "mid"]);
    const axis = brushAxis(1, 73, "log");
    const ties = container.querySelectorAll("i").filter((i) => i.parentElement?.getAttribute("data-lane") && i.parentElement.getAttribute("data-lane") !== "mid");
    expect(ties.map((t) => parseFloat(String(t.style.left)) / 100)).toEqual([axis.position(70), axis.position(71)].map((p) => expect.closeTo(p, 6)));
    expect(handles().map((h) => Number(h.value))).toEqual([70, 71, 72].map((v) => Math.round(axis.position(v) * 1000)));
  });

  it("holds a boundary below the data's values at the axis's start, and keeps the paint valid", async () => {
    // A boundary typed below every value, or left there by a filter, has
    // no place on a log axis. Seeded defect: its logarithm taken before
    // clamping, which made its place, the strip and a neighbour's drag
    // not a number.
    const { onPaintCommit } = render(paint([-5, 2, 9]));
    expect(handles().map((h) => h.value)).toEqual(["0", String(Math.round(brushAxis(1, 73, "log").position(2) * 1000)), String(Math.round(brushAxis(1, 73, "log").position(9) * 1000))]);
    const strip = container.querySelectorAll("div").find((d) => d.children.length === 4 && d.children.every((c) => c.tagName === "I"))!;
    expect(strip.children.every((c) => Number.isFinite(parseFloat(String(c.style.width))))).toBe(true);
    await drag(1, 5.4);
    const saved = (onPaintCommit as ReturnType<typeof vi.fn>).mock.calls[0][0] as QuantileFill;
    expect(saved.breaks).toEqual([-5, 5, 9]);
  });

  it("releases a decimal boundary as nicely as a computed one, not on a whole number", async () => {
    const values = Array.from({ length: 101 }, (_, k) => k * 1.01);
    collisionsOr = distribution(values, "linear", false);
    const p = { ...paint([25.25, 26.1, 75.75]), wholeNumbers: false };
    const { onPaintCommit } = render(p, collisionsOr);
    await drag(0, 25.83);
    const saved = (onPaintCommit as ReturnType<typeof vi.fn>).mock.calls[0][0] as QuantileFill;
    const axis = brushAxis(collisionsOr.min, collisionsOr.max, "linear");
    const dropped = axis.value(axis.position(25.83));
    expect(saved.breaks).toEqual(niceBreaks([dropped, 26.1, 75.75], { lo: collisionsOr.min, hi: collisionsOr.max }));
    // A whole-number release would have taken 26 here.
    expect(saved.breaks[0]).not.toBe(26);
  });
});

describe("the axis's pieces", () => {
  it("maps values to places and back on both axes", () => {
    for (const kind of ["linear", "log"] as const) {
      const axis = brushAxis(1, 73, kind);
      for (const v of [1, 2, 3, 40, 73]) expect(axis.value(axis.position(v))).toBeCloseTo(v, 9);
      expect([axis.position(0.5), axis.position(80), axis.position(0), axis.position(-5)]).toEqual([0, 1, 0, 0]);
    }
  });

  it("puts a value on a break in the lower class", () => {
    expect([0, 1, 1.5, 2, 3, 4].map((v) => classIndex([1, 2, 3], v))).toEqual([0, 0, 1, 1, 2, 3]);
  });

  it("colours a whole-number bar by the first whole number it can hold", () => {
    expect(barValue(1, 1.11, "log", true, false)).toBe(1);
    expect(barValue(1.11, 1.24, "log", true, false)).toBeCloseTo(Math.sqrt(1.11 * 1.24), 9);
    expect(barValue(66, 73, "log", true, true)).toBe(66);
    expect(barValue(0, 10, "linear", false, false)).toBe(5);
  });

  it("staggers only grips that would overlap", () => {
    expect(handleLanes([0, 0.16, 0.25])).toEqual(["mid", "mid", "mid"]);
    expect(handleLanes([0.1, 0.12, 0.5])).toEqual(["up", "down", "mid"]);
    expect(handleLanes([0.98, 0.985, 0.99, 0.995])).toEqual(["up", "down", "mid", "up"]);
  });

  it("snaps a whole-number release in order, or keeps the boundary where it was", () => {
    expect(snapWhole(6.4, 1, 9, 5)).toBe(6);
    expect(snapWhole(2.4, 1, 3, 2)).toBe(2);
    expect(snapWhole(8.9, 1, 9, 5)).toBe(8);
    expect(snapWhole(1.2, 1, 2, 1.5)).toBe(1.5);
    expect(snapWhole(-0.6, -Infinity, 3, 1)).toBe(-1);
  });
});
