import { describe, expect, it } from "vitest";
import { buildClusterIndex, clusterBubbles, type ClusterPoint } from "./cluster";

/** Two tight groups around Berlin, far enough apart to never co-cluster
 * at city zoom, plus one remote outlier. */
function points(): ClusterPoint[] {
  const near = (lng: number, lat: number, i: number): [number, number] => [
    lng + (i % 3) * 0.0002,
    lat + Math.floor(i / 3) * 0.0002,
  ];
  const out: ClusterPoint[] = [];
  for (let i = 0; i < 6; i++) {
    out.push({ position: near(13.4, 52.52, i), properties: { riders: 100 + i } });
  }
  for (let i = 0; i < 3; i++) {
    out.push({ position: near(13.0, 52.3, i), properties: { riders: 10 } });
  }
  out.push({ position: [10.0, 50.0], properties: { riders: 999 } });
  return out;
}

describe("client-side clustering", () => {
  it("clusters by radius with truthful counts and dissolves when zoomed", () => {
    const index = buildClusterIndex(points(), 60, null);
    const coarse = clusterBubbles(index, 5, null);
    // Total membership always equals the input rows.
    expect(coarse.reduce((s, b) => s + b.count, 0)).toBe(10);
    const clusters = coarse.filter((b) => b.clusterId !== null);
    expect(clusters.length).toBeGreaterThan(0);
    for (const c of clusters) {
      expect(c.expansionZoom).not.toBeNull();
      expect(c.properties.points).toBe(c.count);
    }
    // Fully zoomed in, everything is a leaf with its own properties.
    const fine = clusterBubbles(index, 20, null);
    expect(fine.length).toBe(10);
    expect(fine.every((b) => b.clusterId === null)).toBe(true);
    expect(fine.some((b) => b.properties.riders === 999)).toBe(true);
  });

  it("re-clustering from filtered rows keeps counts truthful", () => {
    const filtered = points().filter(
      (p) => Number(p.properties.riders) >= 100,
    );
    const index = buildClusterIndex(filtered, 60, null);
    const bubbles = clusterBubbles(index, 5, null);
    expect(bubbles.reduce((s, b) => s + b.count, 0)).toBe(7);
  });

  it.each([
    ["count", 6],
    ["sum", 100 + 101 + 102 + 103 + 104 + 105],
    ["avg", 102.5],
    ["min", 100],
    ["max", 105],
  ] as const)("aggregates %s over the cluster's rows", (fn, expected) => {
    const aggregate =
      fn === "count"
        ? ({ fn: "count" } as const)
        : ({ fn, attribute: "riders" } as const);
    const index = buildClusterIndex(points(), 60, aggregate);
    // Zoom 10 keeps each tight group as one cluster.
    const bubbles = clusterBubbles(index, 10, aggregate);
    const big = bubbles
      .filter((b) => b.clusterId !== null)
      .find((b) => b.count === 6)!;
    expect(big).toBeDefined();
    expect(big.value).toBe(expected);
  });
});
