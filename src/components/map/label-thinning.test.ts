import { describe, it, expect } from "vitest";
import {
  collisionSizeScale,
  labelPriority,
  rankAndCap,
  rankAndCapCached,
  zoomAdmitsLabels,
} from "./label-thinning";
import type { LabeledFeature } from "@/lib/style/deck-style";

const f = (name: string, riders: unknown): LabeledFeature =>
  ({
    type: "Feature",
    properties: { name, riders },
    geometry: { type: "Point", coordinates: [0, 0] },
  }) as unknown as LabeledFeature;

describe("label thinning pipeline", () => {
  it("ranks descending by the priority column, nulls last, stable ties", () => {
    const data = [f("a", 10), f("b", null), f("c", 30), f("d", 10), f("e", "x")];
    const { data: ranked, total } = rankAndCap(data, {
      priorityField: "riders",
      cap: null,
    });
    expect(total).toBe(5);
    expect(ranked.map((x) => x.properties?.name)).toEqual([
      "c",
      "a",
      "d", // ties by stable feature order
      "b",
      "e", // null and non-numeric rank last, in order
    ]);
  });

  it("caps after ranking; no column keeps feature order", () => {
    const data = [f("a", 1), f("b", 3), f("c", 2)];
    expect(
      rankAndCap(data, { priorityField: "riders", cap: 2 }).data.map(
        (x) => x.properties?.name,
      ),
    ).toEqual(["b", "c"]);
    expect(
      rankAndCap(data, { priorityField: null, cap: 2 }).data.map(
        (x) => x.properties?.name,
      ),
    ).toEqual(["a", "b"]);
  });

  it("the zoom floor gates whole and cheap", () => {
    expect(zoomAdmitsLabels(5, { zoomFloor: 6 })).toBe(false);
    expect(zoomAdmitsLabels(6, { zoomFloor: 6 })).toBe(true);
    expect(zoomAdmitsLabels(0, { zoomFloor: null })).toBe(true);
  });

  it("density maps monotonically: sparser never smaller spacing", () => {
    let previous = Number.POSITIVE_INFINITY;
    for (const d of [0, 0.25, 0.5, 0.75, 1]) {
      const scale = collisionSizeScale(d);
      expect(scale).toBeLessThanOrEqual(previous);
      previous = scale;
    }
    expect(collisionSizeScale(undefined)).toBe(collisionSizeScale(0.5));
  });

  it("density sets the gap a label's whole box keeps from the space claimed above it", () => {
    // The gap is half the claim's excess over the box, in label sizes.
    const gap = (d: number) => (collisionSizeScale(d) - 1) / 2;
    // The densest: labels may touch, never overlap.
    expect(gap(1)).toBe(0);
    // The default: a quarter of a label apart; the sparsest: a whole one.
    expect(gap(0.5)).toBe(0.25);
    expect(gap(0)).toBe(1);
    // Every step of the slider moves it.
    for (const [denser, sparser] of [[1, 0.9], [0.9, 0.75], [0.75, 0.5], [0.5, 0.25], [0.25, 0]]) {
      expect(gap(sparser)).toBeGreaterThan(gap(denser));
    }
  });

  it("priority reads numbers and numeric strings; everything else sinks", () => {
    expect(labelPriority(f("x", 7), "riders")).toBe(7);
    expect(labelPriority(f("x", "7"), "riders")).toBe(7);
    expect(labelPriority(f("x", null), "riders")).toBe(
      Number.NEGATIVE_INFINITY,
    );
  });
});

describe("rank memoization (the contract)", () => {
  it("returns the identical result for identical inputs; recomputes on changed settings", () => {
    const data = [f("a", 1), f("b", 2)];
    const first = rankAndCapCached(data, { priorityField: "riders", cap: null });
    expect(rankAndCapCached(data, { priorityField: "riders", cap: null })).toBe(first);
    const capped = rankAndCapCached(data, { priorityField: "riders", cap: 1 });
    expect(capped).not.toBe(first);
    expect(capped.data).toHaveLength(1);
  });
});
