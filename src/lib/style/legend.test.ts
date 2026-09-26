// The all-constant swatch: the one colour a flat layer draws — stroke
// for stroked geometries, fill elsewhere — and nothing when channels
// are data-driven or the visualization owns its own presentation.
// LegendFor's own null-for-constants answer is pinned too: label slots
// stay a data-driven concern.
import { describe, expect, it } from "vitest";
import { constantSwatch, legendFor } from "./legend";
import { defaultStyle } from "./defaults";

describe("constantSwatch", () => {
  it("gives an all-constant point layer its fill", () => {
    const style = defaultStyle("POINT", 0);
    expect(style.fill.type).toBe("constant");
    expect(constantSwatch(style, undefined, "POINT")).toEqual(
      style.fill.type === "constant" ? style.fill.color : null,
    );
  });

  it("gives an all-constant line layer its stroke — the colour it draws", () => {
    const style = defaultStyle("LINESTRING", 0);
    expect(constantSwatch(style, undefined, "LINESTRING")).toEqual(
      style.stroke,
    );
  });

  it("stays null when a channel is data-driven", () => {
    const style = defaultStyle("POINT", 0);
    const driven = {
      ...style,
      fill: {
        type: "quantile" as const,
        attribute: "x",
        palette: "global_warming",
        breaks: [1],
        colors: [
          { r: 1, g: 2, b: 3, a: 1 },
          { r: 4, g: 5, b: 6, a: 1 },
        ],
      },
    };
    expect(constantSwatch(driven, undefined, "POINT")).toBeNull();
  });

  it("stays null for heatmaps — they own their presentation", () => {
    const style = defaultStyle("POINT", 0);
    expect(
      constantSwatch(style, { type: "heatmap" } as never, "POINT"),
    ).toBeNull();
  });

  it("legendFor itself still answers null for constants — slots stay data-driven", () => {
    const style = defaultStyle("POINT", 0);
    expect(legendFor(style)).toBeNull();
  });
});

describe("legendItems' special presentations stay their own", () => {
  it("a cluster keeps its count-size legend — no constant row", () => {
    const style = defaultStyle("POINT", 0);
    const legend = legendFor(style, {
      type: "cluster",
      radiusKm: 1,
    } as never);
    expect(legend).not.toBeNull();
    expect(legend!.sizes[0]?.attribute).toBe("point count");
    expect(
      constantSwatch(style, { type: "cluster", radiusKm: 1 } as never, "POINT"),
    ).toBeNull();
  });
});
