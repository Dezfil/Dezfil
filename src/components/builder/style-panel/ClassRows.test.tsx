import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostElement, installDomHost } from "@/components/testing/dom-host";
import { paintLegend } from "@/lib/style/legend";
import type { FillPaint, QuantileFill } from "@/lib/style/style";
import { ClassRows } from "./ClassRows";

/**
 * The Style panel's class rows, rendered: each bounded row reads the
 * legend's own text with its upper boundary as an editable input, and that
 * input holds every digit of the break. The seeded defects are the rows
 * these replaced: a hard-coded "<" before the first boundary, and an input
 * that showed 1.234561e-5 and 1.234562e-5 both as "1.23e-5".
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

function paint(breaks: number[]): QuantileFill {
  return {
    type: "quantile",
    attribute: "v",
    palette: "global_warming",
    method: "quantile",
    breaks,
    colors: Array.from({ length: breaks.length + 1 }, (_, i) => ({ r: 40 * i, g: 10, b: 10, a: 1 })),
  };
}

function render(p: QuantileFill, onPaint: (p: FillPaint) => void = () => {}) {
  act(() =>
    root.render(
      <ClassRows paint={p} legend={paintLegend(p)!} channel="Fill" custom={false} disabled={false} onPaint={onPaint} />,
    ),
  );
}

const boundaries = () =>
  container.querySelectorAll("input").filter((input) => input.getAttribute("aria-label")?.startsWith("Fill class boundary"));

/** What a row reads: its text with each input's value in place. */
function rowText(row: HostElement): string {
  const label = row.children.find((c) => c.tagName === "SPAN")!;
  return label.childNodes
    .map((n) => (n instanceof HostElement && n.tagName === "INPUT" ? n.value : n.textContent))
    .join("");
}

function props(el: HostElement) {
  const key = Object.keys(el).find((name) => name.startsWith("__reactProps$"))!;
  return (el as unknown as Record<string, Record<string, (e: unknown) => void>>)[key];
}

describe("the Style panel's class rows", () => {
  it("read exactly what the legend reads, row by row", () => {
    const p = paint([1, 2, 3]);
    render(p);
    const rows = container.querySelectorAll("div").filter((d) => d.children[0]?.getAttribute("type") === "color");
    expect(rows.map(rowText)).toEqual(paintLegend(p)!.entries.map((e) => e.label));
    expect(rows.map(rowText)).toEqual(["≤ 1", "1 – 2", "2 – 3", "> 3"]);
  });

  it("name the whole numbers a class holds, the boundary input in its place", () => {
    for (const [breaks, texts] of [
      [[1, 2, 3], ["≤ 1", "2", "3", "> 3"]],
      [[4, 14, 27, 42], ["≤ 4", "5 – 14", "15 – 27", "28 – 42", "> 42"]],
    ] as const) {
      const p = { ...paint([...breaks]), wholeNumbers: true };
      render(p);
      const rows = container.querySelectorAll("div").filter((d) => d.children[0]?.getAttribute("type") === "color");
      expect(rows.map(rowText)).toEqual([...texts]);
      expect(rows.map(rowText)).toEqual(paintLegend(p)!.entries.map((e) => e.label));
      expect(boundaries().map((input) => Number(input.value))).toEqual([...breaks]);
    }
  });

  it("keeps two tiny boundaries apart in their inputs", () => {
    render(paint([1.234561e-5, 1.234562e-5]));
    const shown = boundaries().map((input) => input.value);
    expect(shown[0]).not.toBe(shown[1]);
    expect(shown.map(Number)).toEqual([1.234561e-5, 1.234562e-5]);
  });

  it("keeps two high-precision boundaries apart in their inputs", () => {
    render(paint([0.123456789012, 0.123456789013]));
    const shown = boundaries().map((input) => Number(input.value.replace(/,/g, "")));
    expect(shown).toEqual([0.123456789012, 0.123456789013]);
  });

  it("commits nothing when a boundary is left untouched", () => {
    const onPaint = vi.fn();
    render(paint([1.234561e-5, 1.234562e-5]), onPaint);
    for (const input of boundaries()) act(() => props(input).onBlur({}));
    expect(onPaint).not.toHaveBeenCalled();
  });

  it("round-trips a typed boundary as a Custom edit", () => {
    const onPaint = vi.fn();
    render(paint([1, 2, 3]), onPaint);
    const second = boundaries()[1];
    act(() => props(second).onChange({ target: { value: "2.125" } }));
    act(() => props(second).onBlur({}));
    expect(onPaint).toHaveBeenCalledTimes(1);
    const next = onPaint.mock.calls[0][0] as QuantileFill;
    expect(next.breaks).toEqual([1, 2.125, 3]);
    expect(next.method).toBe("custom");
    expect(next.baseMethod).toBe("quantile");
    render(next, onPaint);
    expect(boundaries()[1].value).toBe("2.125");
  });
});
