import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi";

describe("documented camera bounds", () => {
  const schemas = buildOpenApiDocument().components.schemas;
  it("maps and image schemas carry independently ruled endpoints", () => {
    const image = schemas.ExportImageDefinition.properties.viewport.properties;
    for (const [properties, floor] of [[schemas.Viewport.properties, -2], [image, 0]] as const) {
      expect(properties.pitch).toMatchObject({ minimum: 0, maximum: 60 });
      expect(properties.lat).toMatchObject({ minimum: -85.051129, maximum: 85.051129 });
      expect(properties.zoom).toMatchObject({ minimum: floor, maximum: 24 });
    }
  });
  it("Viewport prose carries the same ruled bounds and coverage qualification", () => {
    const prose = schemas.Viewport.description;
    expect(prose).toContain("pitch 0 to 60");
    expect(prose).toContain("latitude -85.051129 to 85.051129");
    expect(prose).toContain("zoom -2 to 24");
    expect(prose).toContain("log2(canvas height / 512)");
    expect(prose).toContain("toward the equator");
    expect(prose).not.toContain("85°");
  });
});
