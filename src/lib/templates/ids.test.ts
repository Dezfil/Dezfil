import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { parseTemplateDocumentId, templateDocumentId, type TemplateDocumentRef } from "./ids";

/**
 * A template's documents and datasets are addressed by ids of their own
 * form, minted and read by one module, so a stored row's id is never read
 * as a template's and a template's never reaches a store query as a row's.
 */

describe("template document ids", () => {
  const refs: TemplateDocumentRef[] = [
    { template: "harbour-stations", version: 1, kind: "map" },
    { template: "harbour-stations", version: 12, kind: "workflow" },
    { template: "busy-stations", version: 3, kind: "layer", part: "layer-rings" },
    { template: "busy-stations", version: 3, kind: "dataset", part: "station_rings" },
    { template: "busy-stations", version: 3, kind: "result", part: "step-busy" },
  ];

  it("read back whole, each kind", () => {
    for (const ref of refs) expect(parseTemplateDocumentId(templateDocumentId(ref))).toEqual(ref);
    expect(templateDocumentId(refs[2])).toBe("template.busy-stations.3.layer.layer-rings");
  });

  it("are never a stored row's id, and a row's id is never read as one", () => {
    const row = randomUUID();
    expect(parseTemplateDocumentId(row)).toBeNull();
    for (const ref of refs) expect(templateDocumentId(ref)).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("refuse what does not read back as one", () => {
    for (const id of [
      "template.harbour-stations.1.map.extra", "template.harbour-stations.1.layer", "template.Harbour.1.map",
      "template.harbour-stations.0.map", "template.harbour-stations.1.sketch.x", "template.harbour-stations.1.layer.a.b",
      "templates.harbour-stations.1.map", "", "template.harbour-stations.01.map",
    ]) expect(parseTemplateDocumentId(id), id).toBeNull();
    expect(() => templateDocumentId({ template: "harbour-stations", version: 1, kind: "layer" })).toThrow();
    expect(() => templateDocumentId({ template: "harbour-stations", version: 1, kind: "map", part: "x" })).toThrow();
    expect(() => templateDocumentId({ template: "harbour-stations", version: 1, kind: "dataset", part: "a.b" })).toThrow();
    expect(() => templateDocumentId({ template: "harbour-stations", version: 0, kind: "map" })).toThrow();
  });
});
