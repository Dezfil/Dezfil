import { expect, it } from "vitest";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import { defaultStyle } from "./defaults";
import { normalizeStyle, styleProblem, type LayerStyle } from "./style";

it("accepts every published style member used by clients", () => {
  const base = defaultStyle("POINT");
  const scale = { attribute: "value", domain: [0, 1], range: [1, 10] } as const;
  const style: Required<LayerStyle> = {
    ...base, strokeBy: base.fill,
    pointRadiusBy: { ...scale, domain: [0, 1], range: [1, 10] },
    strokeWidthBy: { ...scale, domain: [0, 1], range: [1, 10] },
    heightBy: { ...scale, domain: [0, 1], range: [1, 10] },
    label: { attribute: "name", size: 12, color: base.stroke, haloWidth: 1, haloColor: base.stroke },
  };
  const schema = buildOpenApiDocument().components.schemas.Style;
  expect(Object.keys(style).sort()).toEqual(Object.keys(schema.properties).sort());
  expect(styleProblem(style)).toBeNull();
  expect(schema.additionalProperties).toBe(false);
});

it("keeps existing unknown members when reading a stored style", () => {
  const stored = { ...defaultStyle("POINT"), undefined: 4 };
  expect(normalizeStyle(stored)).toHaveProperty("undefined", 4);
});
