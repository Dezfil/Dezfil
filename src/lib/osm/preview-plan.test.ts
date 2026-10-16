import osmtogeojson from "osmtogeojson";
import { describe, expect, it } from "vitest";
import { jsonBytes } from "@/lib/query/result-budget";
import { overpassResponse } from "@/lib/test-support/overpass-responses";
import { featureBytes } from "./feature-bytes";
import { featureClass, featureWithin, shapeFeature, type BuiltFeature, type GeometryClass, type WithinShape } from "./geometry";
import { planPreview } from "./preview-plan";

/**
 * The stand-ins an OpenStreetMap preview assembles in place of features
 * too large for its answer, held against the assembler itself: over
 * responses of every shape Overpass writes, each feature comes back in the
 * same place with the same class and the same answer to whether it lies
 * in the area, the lines and polygons that do not fit carry their exact
 * size and are built small, and every other feature is the one the whole
 * response gives, byte for byte.
 */

const PROMOTED = ["name", "highway"];
const AREAS: [string, WithinShape | null][] = [["no area", null], ["an area", { bbox: [13.4, 52.4, 13.5, 52.6] }]];
const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);

/** Every feature the assembler builds from a response, in its order. */
function assemble(response: unknown): BuiltFeature[] {
  const features: BuiltFeature[] = [];
  osmtogeojson(response, { flatProperties: false }, (feature) => { features.push(feature); });
  return features;
}

interface Original { cls: GeometryClass | null; geometry: unknown; size: number; json: string }

function originals(seed: number): Original[] {
  return assemble(overpassResponse(seed)).map((feature) => {
    const one = shapeFeature(feature, PROMOTED);
    const json = one ? JSON.stringify(one.shaped) : "";
    return { cls: featureClass(feature), geometry: feature.geometry, size: Buffer.byteLength(json, "utf8"), json };
  });
}

/** Rooms at, and one byte under, sizes of features the response holds,
 * and none at all. */
function rooms(features: Original[]): number[] {
  const sizes = [...new Set(features.filter((f) => f.cls).map((f) => f.size))].sort((a, b) => a - b);
  const chosen = [sizes[0], sizes[Math.floor(sizes.length / 2)], sizes[sizes.length - 1], sizes[Math.floor(sizes.length / 4)]];
  return [0, ...new Set(chosen.flatMap((size) => [size, size - 1]))];
}

describe("the size of a preview feature", () => {
  it.each(SEEDS)("is measured to the byte without serializing its tags: response %i", (seed) => {
    let measured = 0;
    for (const feature of assemble(overpassResponse(seed))) {
      const one = shapeFeature(feature, PROMOTED);
      if (!one) continue;
      expect(featureBytes(feature, PROMOTED)).toBe(Buffer.byteLength(JSON.stringify(one.shaped), "utf8"));
      measured++;
    }
    expect(measured).toBeGreaterThan(5);
  });
});

describe("the stand-ins of a preview", () => {
  it.each(SEEDS)("keep every decision of the assembler and every other feature byte for byte: response %i", (seed) => {
    const before = originals(seed);
    let stoodIn = 0;
    for (const [area, within] of AREAS) {
      for (const room of rooms(before)) {
        const plan = planPreview(overpassResponse(seed), PROMOTED, within, room);
        const after = assemble(plan.response).filter((feature) => !plan.added(feature));
        const where = `${area}, room ${room}`;
        expect(after.length, where).toBe(before.length);
        after.forEach((feature, i) => {
          const original = before[i];
          expect(featureClass(feature), `${where}, feature ${i}`).toBe(original.cls);
          if (!original.cls) return;
          if (within) {
            expect(featureWithin(feature, within), `${where}, feature ${i}`).toBe(featureWithin({ geometry: original.geometry }, within));
          }
          const sized = plan.sized(feature);
          // A point is built from its one pair and holds its tags as they
          // are, so it is built as it is and measured when it comes back.
          if (original.size > room && original.cls !== "points") {
            // Measured exactly, and built from a few nodes only.
            expect(sized, `${where}, feature ${i}`).toBe(original.size);
            expect(jsonBytes(feature.geometry), `${where}, feature ${i}`).toBeLessThanOrEqual(Math.max(room, 1024));
            stoodIn++;
          } else {
            expect(sized, `${where}, feature ${i}`).toBeNull();
            expect(JSON.stringify(shapeFeature(feature, PROMOTED)!.shaped), `${where}, feature ${i}`).toBe(original.json);
          }
        });
      }
    }
    expect(stoodIn).toBeGreaterThan(0);
  });

  it("leave a response with nothing too large as it is", () => {
    const response = overpassResponse(7);
    expect(planPreview(response, PROMOTED, null, Number.MAX_SAFE_INTEGER).response).toBe(response);
  });

  it("leave a way whole, as before, when a node of it has two positions", () => {
    // Overpass gives a node one position; this response gives node 2 two.
    const response = {
      version: 0.6,
      elements: [
        { type: "way", id: 1, nodes: [1, 2, 3], geometry: [{ lat: 52.4, lon: 13.3 }, { lat: 52.41, lon: 13.31 }, { lat: 52.42, lon: 13.32 }], tags: { highway: "primary" } },
        { type: "way", id: 2, nodes: [2, 4], geometry: [{ lat: 52.5, lon: 13.5 }, { lat: 52.51, lon: 13.51 }], tags: { highway: "service" } },
      ],
    };
    expect(planPreview(response, PROMOTED, null, 0).response).toBe(response);
  });
});
