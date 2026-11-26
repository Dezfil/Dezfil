import { expect, it } from "vitest";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import { defaultStyle } from "./defaults";
import { LABEL_PAINT_CHOICES, normalizeStyle, styleProblem, type LabelStyle, type LayerStyle } from "./style";

it("accepts every published style member used by clients", () => {
  const base = defaultStyle("POINT");
  const scale = { attribute: "value", domain: [0, 1], range: [1, 10] } as const;
  const style: Required<LayerStyle> = {
    ...base, strokeBy: base.fill,
    pointRadiusBy: { ...scale, domain: [0, 1], range: [1, 10] },
    strokeWidthBy: { ...scale, domain: [0, 1], range: [1, 10] },
    heightBy: { ...scale, domain: [0, 1], range: [1, 10] },
    label: { attribute: "name", size: 12, textPaint: "own", color: base.stroke, haloPaint: "own", haloWidth: 1, haloColor: base.stroke },
  };
  const schemas = buildOpenApiDocument().components.schemas;
  for (const schema of [schemas.Style, schemas.StyleInput]) {
    expect(Object.keys(style).sort()).toEqual(Object.keys(schema.properties).sort());
    expect(schema.additionalProperties).toBe(false);
  }
  expect(styleProblem(style)).toBeNull();
  expect(normalizeStyle(style)).toEqual(style);
});

it("ties every label member to the label the description publishes, accepted and answered", () => {
  // Every member the label type has, so a member added to the type and not
  // to the description (or the reverse) fails here.
  const color = { r: 1, g: 2, b: 3, a: 1 };
  const label: Required<LabelStyle> = {
    attribute: "name", size: 12, textPaint: "own", color, haloPaint: "own", haloWidth: 1, haloColor: color,
    weight: "bold", anchor: "top", offsetX: 1, offsetY: 2, rotation: 3, textCase: "upper", maxChars: 10,
    density: 0.5, zoomFloor: 3, priorityField: "rank", cap: 100,
  };
  const schemas = buildOpenApiDocument().components.schemas;
  const answered = schemas.Style.properties.label;
  const accepted = schemas.StyleInput.properties.label;
  expect(Object.keys(answered.properties).sort()).toEqual(Object.keys(label).sort());
  // One set of definitions: the two forms differ only in what they require.
  expect(accepted.properties).toEqual(answered.properties);
  expect(accepted.description).toBe(answered.description);
  expect(accepted.required).toEqual(["size"]);
  expect([...answered.required].sort()).toEqual(["color", "haloColor", "haloPaint", "haloWidth", "size", "textPaint"]);
  expect(answered.properties.textPaint.enum).toEqual([...LABEL_PAINT_CHOICES]);
  expect(answered.properties.haloPaint.enum).toEqual([...LABEL_PAINT_CHOICES]);
  expect(styleProblem({ ...defaultStyle("POINT"), label })).toBeNull();
  // A write accepts the style only in its accepted form; an answer carries the answered one.
  const layers = schemas as unknown as Record<string, { properties: { style: { $ref: string } } }>;
  expect(layers.LayerCreate.properties.style.$ref).toBe("#/components/schemas/StyleInput");
  expect(layers.LayerUpdate.properties.style.$ref).toBe("#/components/schemas/StyleInput");
  expect(layers.Layer.properties.style.$ref).toBe("#/components/schemas/Style");
});

it("drops unknown members on read without changing the stored style", () => {
  const stored = { ...defaultStyle("POINT"), undefined: 4 };
  expect(normalizeStyle(stored)).toEqual(defaultStyle("POINT"));
  expect(stored).toHaveProperty("undefined", 4);
});
