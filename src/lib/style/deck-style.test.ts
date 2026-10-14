import { describe, it, expect } from "vitest";
import {
  deckLayerProps,
  deckUpdateTriggers,
  deckLabelProps,
  fillAccessor,
  opaqueFillPaint,
  sizeAccessor,
  labelText,
  labelPosition,
} from "./deck-style";
import { defaultStyle } from "./defaults";
import type { FillPaint, LabelStyle, SizeScale } from "./style";

const scale: SizeScale = { attribute: "pop", domain: [0, 100], range: [4, 28] };
const f = (pop: unknown) => ({ properties: { pop } });

describe("sizeAccessor", () => {
  it("maps the domain ends onto the range ends", () => {
    for (const curve of ["sqrt", "linear"] as const) {
      const size = sizeAccessor(scale, curve);
      expect(size(f(0))).toBe(4);
      expect(size(f(100))).toBe(28);
    }
  });

  it("is area-honest on the sqrt curve: a quarter of the value, half the radius gain", () => {
    const size = sizeAccessor(scale, "sqrt");
    expect(size(f(25))).toBeCloseTo(4 + (28 - 4) * 0.5, 6);
    const linear = sizeAccessor(scale, "linear");
    expect(linear(f(25))).toBeCloseTo(4 + (28 - 4) * 0.25, 6);
  });

  it("draws missing values smallest and clamps beyond the domain", () => {
    const size = sizeAccessor(scale, "sqrt");
    expect(size(f(undefined))).toBe(4);
    expect(size(f("not a number"))).toBe(4);
    expect(size(f(-50))).toBe(4);
    expect(size(f(1e9))).toBe(28);
    expect(size({ properties: null })).toBe(4);
  });

  it("draws a null or empty value smallest too, never as 0 on a domain that reaches past it", () => {
    for (const domain of [[-100, -10], [-50, 50]] as [number, number][]) {
      const size = sizeAccessor({ ...scale, domain }, "sqrt");
      expect(size(f(null)), String(domain)).toBe(4);
      expect(size(f("")), String(domain)).toBe(4);
    }
    expect(sizeAccessor({ ...scale, domain: [-50, 50] }, "linear")(f(null))).toBe(4);
  });

  it("keeps order on negative domains and collapses to smallest on a flat one", () => {
    const negative = sizeAccessor(
      { ...scale, domain: [-100, -10] },
      "sqrt",
    );
    expect(negative(f(-100))).toBe(4);
    expect(negative(f(-10))).toBe(28);
    expect(negative(f(-50))).toBeGreaterThan(4);
    const flat = sizeAccessor({ ...scale, domain: [7, 7] }, "sqrt");
    expect(flat(f(7))).toBe(4);
  });
});

describe("deckLayerProps channels", () => {
  const strokeBy: FillPaint = {
    type: "categorical",
    attribute: "kind",
    palette: "uber_viz_qualitative",
    map: [{ value: "a", color: { r: 1, g: 2, b: 3, a: 1 } }],
    other: { r: 9, g: 9, b: 9, a: 1 },
  };

  it("keeps constants when the data-driven members are absent", () => {
    const props = deckLayerProps(defaultStyle("POINT"));
    expect(Array.isArray(props.getLineColor)).toBe(true);
    expect(typeof props.getLineWidth).toBe("number");
    expect(typeof props.getPointRadius).toBe("number");
  });

  it("turns each channel into a per-feature accessor when driven", () => {
    const style = {
      ...defaultStyle("POINT"),
      strokeBy,
      strokeOpacity: 1,
      pointRadiusBy: scale,
      strokeWidthBy: { ...scale, range: [1, 8] as [number, number] },
    };
    const props = deckLayerProps(style);
    expect(typeof props.getLineColor).toBe("function");
    expect(typeof props.getLineWidth).toBe("function");
    expect(typeof props.getPointRadius).toBe("function");
    const line = props.getLineColor as (x: unknown) => number[];
    expect(line({ properties: { kind: "a" } })).toEqual([1, 2, 3, 255]);
    expect(line({ properties: { kind: "zz" } })).toEqual([9, 9, 9, 255]);
  });

  it("applies the stroke opacity multiplier to a data-driven outline", () => {
    const style = { ...defaultStyle("POINT"), strokeBy, strokeOpacity: 0.5 };
    const line = deckLayerProps(style).getLineColor as (
      x: unknown,
    ) => number[];
    expect(line({ properties: { kind: "a" } })[3]).toBe(128);
  });

  it("enumerates every data-driven input in the shared update triggers", () => {
    const style = {
      ...defaultStyle("POINT"),
      strokeBy,
      pointRadiusBy: scale,
      strokeWidthBy: scale,
    };
    const triggers = deckUpdateTriggers(style);
    expect(triggers.getLineColor).toContain(style.strokeBy);
    expect(triggers.getPointRadius).toContain(style.pointRadiusBy);
    expect(triggers.getLineWidth).toContain(style.strokeWidthBy);
    expect(triggers.getFillColor).toContain(style.fill);
  });
});

describe("fillAccessor fallbacks", () => {
  it("keeps first-class behavior for ramp fills with missing values", () => {
    const ramp: FillPaint = {
      type: "quantile",
      attribute: "v",
      palette: "global_warming",
      breaks: [10],
      colors: [
        { r: 1, g: 1, b: 1, a: 1 },
        { r: 2, g: 2, b: 2, a: 1 },
      ],
    };
    const fill = fillAccessor(ramp) as (x: unknown) => number[];
    expect(fill({ properties: { v: 5 } })[0]).toBe(1);
    expect(fill({ properties: { v: 50 } })[0]).toBe(2);
    expect(fill({ properties: {} })[0]).toBe(1);
  });
});

describe("opaqueFillPaint (icon tinting)", () => {
  it("forces authored alpha to 1 across every paint shape", () => {
    const constant: FillPaint = {
      type: "constant",
      color: { r: 18, g: 147, b: 154, a: 0.72 },
    };
    const solidConstant = opaqueFillPaint(constant);
    expect(solidConstant.type === "constant" && solidConstant.color.a).toBe(1);

    const categorical: FillPaint = {
      type: "categorical",
      attribute: "kind",
      palette: "qualitative",
      map: [{ value: "a", color: { r: 1, g: 2, b: 3, a: 0.5 } }],
      other: { r: 9, g: 9, b: 9, a: 0.3 },
    };
    const solidCat = opaqueFillPaint(categorical);
    expect(
      solidCat.type === "categorical" &&
        solidCat.map.every((e) => e.color.a === 1) &&
        solidCat.other.a === 1,
    ).toBe(true);

    const ramp: FillPaint = {
      type: "quantile",
      attribute: "v",
      palette: "global_warming",
      breaks: [10],
      colors: [
        { r: 1, g: 1, b: 1, a: 0.72 },
        { r: 2, g: 2, b: 2, a: 1 },
      ],
    };
    const solidRamp = opaqueFillPaint(ramp);
    expect(
      solidRamp.type === "quantile" &&
        solidRamp.colors.every((c) => c.a === 1),
    ).toBe(true);
  });

  it("still honors the fill-opacity slider after solidifying", () => {
    const fill = fillAccessor(
      opaqueFillPaint({
        type: "constant",
        color: { r: 10, g: 20, b: 30, a: 0.72 },
      }),
      0.5,
    ) as number[];
    expect(fill[3]).toBe(128);
  });
});

describe("labels", () => {
  const label: LabelStyle = {
    attribute: "name",
    size: 12,
    color: { r: 255, g: 255, b: 255, a: 1 },
    haloWidth: 1, haloColor: { r: 12, g: 16, b: 24, a: 0.8 },
  };

  it("labels by attribute; numbers format like the legend", () => {
    const text = labelText(label);
    expect(text({ properties: { name: "Alexanderplatz" } })).toBe(
      "Alexanderplatz",
    );
    const numeric = labelText({ ...label, attribute: "riders" });
    expect(numeric({ properties: { riders: 22310 } })).toBe("22,300");
    expect(numeric({ properties: { riders: 7.163 } })).toBe("7.16");
  });

  it("labels aggregated cells with their value when no attribute is set", () => {
    const text = labelText({ ...label, attribute: undefined });
    expect(text({ properties: { value: 14600, count: 12 } })).toBe("14,600");
  });

  it("features without text or position are unlabeled", () => {
    const text = labelText(label);
    expect(text({ properties: { name: null } })).toBeNull();
    expect(text({ properties: {} })).toBeNull();
    expect(text({ properties: { name: "" } })).toBeNull();
    expect(labelPosition({ properties: {}, geometry: null })).toBeNull();
  });

  it("text that is only blank space is no label, whatever its length or case", () => {
    for (const blank of [" ", "   ", "\t", "\n ", "\u00a0", "\u3000"]) {
      expect(labelText(label)({ properties: { name: blank } }), JSON.stringify(blank)).toBeNull();
      expect(labelText({ ...label, textCase: "upper" })({ properties: { name: blank } })).toBeNull();
    }
    // Cut short, a long blank would still leave its ellipsis to draw.
    expect(labelText({ ...label, maxChars: 2 })({ properties: { name: "      " } })).toBeNull();
    // Space inside or around real text is part of it.
    expect(labelText(label)({ properties: { name: " Mitte " } })).toBe(" Mitte ");
    expect(labelText(label)({ properties: { name: "Prenzlauer Berg" } })).toBe("Prenzlauer Berg");
  });

  it("anchors points on themselves and everything else on __anchor", () => {
    expect(
      labelPosition({
        properties: {},
        geometry: { type: "Point", coordinates: [13.4, 52.5] },
      }),
    ).toEqual([13.4, 52.5]);
    expect(
      labelPosition({
        properties: { __anchor: [1, 2] },
        geometry: { type: "Polygon", coordinates: [] },
      }),
    ).toEqual([1, 2]);
  });

  it("the halo toggles the SDF outline; the atlas follows the data", () => {
    const on = deckLabelProps(label);
    expect(on.outlineWidth).toBeGreaterThan(0);
    expect(on.fontSettings).toEqual({ sdf: true });
    expect(on.characterSet).toBe("auto");
    expect(deckLabelProps({ ...label, haloWidth: 0, haloColor: { r: 12, g: 16, b: 24, a: 0.8 } }).outlineWidth).toBe(0);
  });

  it("draws the widest halo as given, unclamped", () => {
    expect(deckLabelProps({ ...label, haloWidth: 3 }).outlineWidth).toBe(3);
  });
});
