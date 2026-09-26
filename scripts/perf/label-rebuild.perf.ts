/**
 * Profiling harness: the per-tick label rebuild.
 *
 * Measurement only. Nothing here is product code and nothing here runs in
 * the default test suite (`vitest.config.ts` includes only
 * `src/**\/*.test.ts`). Re-run with:
 *
 *   npx vitest run --config scripts/perf/vitest.perf.config.ts
 *
 * What it measures — and what it does NOT. Since an earlier extraction the shipped
 * per-tick path goes through `labelStore.read`, which normally returns a
 * CACHED array; a labelled layer no longer re-derives on every build. This
 * harness calls `labelableFeatures` directly, so its numbers are the **raw
 * derivation cost — the work the cache now avoids**, not the cost of a
 * shipped tick. Read it as the size of the prize, or as a regression watch
 * on the derivation itself; do not quote it as current product behaviour.
 * For the cost of a real tick, use the browser harness
 * (`scripts/perf/label-drag-frames.spec.ts`), which drives the actual
 * slider against the actual render loop.
 *
 * Before that this WAS the per-tick path: `buildDeckLayers` re-derived a
 * fresh filtered array on every call, where heat/OD/icon/cluster layers kept
 * an identity cache. A fresh array identity is what makes deck.gl invalidate
 * and re-upload the TextLayer's attributes, so this measured the *entry*
 * cost of that re-upload, never the whole of it (the GPU-side half needs a
 * browser; see the findings document).
 *
 * It imports the shipped `labelableFeatures` (moved out of
 * `MapCanvas` into `src/components/map/label-data.ts` partly for this
 * reason). It used to carry a hand-copied replica, because the function was
 * module-local and unimportable — a measurement of a copy is a number that
 * can quietly stop describing the code it claims to describe.
 */
import { describe, it } from "vitest";
import {
  deckLabelProps,
  labelPosition,
  labelText,
  type LabeledFeature,
} from "@/lib/style/deck-style";
import { labelableFeatures } from "@/components/map/label-data";
import type { LabelStyle } from "@/lib/style/style";

// ------------------------------------------------------------------ timing

interface Stats {
  n: number;
  cold: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
}

function quantile(sorted: number[], q: number): number {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** Run `fn` once (recorded separately as cold), then `reps` more times. */
function measure(reps: number, fn: () => void): Stats {
  const t0 = performance.now();
  fn();
  const cold = performance.now() - t0;
  const samples: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t = performance.now();
    fn();
    samples.push(performance.now() - t);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: reps,
    cold,
    min: sorted[0],
    p25: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    max: sorted[sorted.length - 1],
  };
}

const ms = (v: number) => v.toFixed(3).padStart(9);

function row(label: string, s: Stats): string {
  return `  ${label.padEnd(34)} cold ${ms(s.cold)}  min ${ms(s.min)}  p25 ${ms(
    s.p25,
  )}  median ${ms(s.median)}  p75 ${ms(s.p75)}  max ${ms(s.max)}  (n=${s.n})`;
}

// ------------------------------------------------------------------ fixture

/**
 * A point layer as the server ships it: a FeatureCollection whose features
 * carry the labelled attribute plus a handful of other properties, which is
 * what a real uploaded table produces. Label text lengths vary the way place
 * names do — the glyph count, not the feature count, is what a TextLayer
 * actually uploads.
 */
function pointCollection(count: number): {
  features: LabeledFeature[];
} {
  const features: LabeledFeature[] = [];
  for (let i = 0; i < count; i++) {
    features.push({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [-122.4 + (i % 997) * 1e-4, 37.7 + (i % 991) * 1e-4],
      },
      properties: {
        name: `Station ${i}`,
        category: i % 7 === 0 ? "transit" : "retail",
        magnitude: (i % 400) / 4,
        elevation_m: i % 1200,
        updated_at: "2024-01-01T08:30:00",
      },
    } as unknown as LabeledFeature);
  }
  return { features };
}

/** Polygon collection: labels ride the server-computed `__anchor`. */
function polygonCollection(count: number): { features: LabeledFeature[] } {
  const features: LabeledFeature[] = [];
  for (let i = 0; i < count; i++) {
    const x = -122.4 + (i % 997) * 1e-4;
    const y = 37.7 + (i % 991) * 1e-4;
    features.push({
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [x, y],
            [x + 5e-5, y],
            [x + 5e-5, y + 5e-5],
            [x, y + 5e-5],
            [x, y],
          ],
        ],
      },
      properties: {
        name: `District ${i}`,
        __anchor: [x + 2.5e-5, y + 2.5e-5],
        population: i * 13,
      },
    } as unknown as LabeledFeature);
  }
  return { features };
}

const LABEL: LabelStyle = {
  attribute: "name",
  size: 12,
  color: { r: 240, g: 244, b: 248, a: 1 },
  haloWidth: 0, haloColor: { r: 12, g: 16, b: 24, a: 0.8 },
};

/** A partially labellable collection — the filter's real job. */
function sparseCollection(count: number, labelledEvery: number) {
  const fc = pointCollection(count);
  for (let i = 0; i < fc.features.length; i++) {
    if (i % labelledEvery !== 0) {
      (fc.features[i].properties as Record<string, unknown>).name = null;
    }
  }
  return fc;
}

// 250,000 is `limits.renderCapFeatures` — the documented per-layer inline
// render cap, so it bounds the worst case an inline labelled layer can reach.
const COUNTS = [1_000, 10_000, 100_000, 250_000];
const REPS = 40;

describe("label sublayer rebuild per draft tick", () => {
  it("rebuild cost by feature count (points)", () => {
    const lines: string[] = [];
    for (const count of COUNTS) {
      const fc = pointCollection(count);
      // Timing FIRST, metadata after: deriving the kept
      // and glyph counts up front pre-warmed the function, so the "cold"
      // sample was really the third execution against that fixture. The
      // cold column now means what it says on every row.
      const stats = measure(REPS, () => {
        labelableFeatures(fc, LABEL);
      });
      const kept = labelableFeatures(fc, LABEL);
      const text = labelText(LABEL);
      let glyphs = 0;
      for (const f of kept) glyphs += (text(f) ?? "").length;
      lines.push(
        row(`points ${count} (kept ${kept.length}, ${glyphs} glyphs)`, stats),
      );
    }
    console.log(
      "\nlabelableFeatures — the fresh array deck sees as new data\n" +
        lines.join("\n"),
    );
  });

  it("rebuild cost by feature count (polygons via __anchor)", () => {
    const lines: string[] = [];
    for (const count of COUNTS) {
      const fc = polygonCollection(count);
      lines.push(
        row(
          `polygons ${count}`,
          measure(REPS, () => {
            labelableFeatures(fc, LABEL);
          }),
        ),
      );
    }
    console.log("\nlabelableFeatures — polygon anchors\n" + lines.join("\n"));
  });

  it("rebuild cost when most features are unlabellable", () => {
    const lines: string[] = [];
    for (const count of COUNTS) {
      const fc = sparseCollection(count, 10);
      // Timing first, metadata after — same reason as the points row.
      const stats = measure(REPS, () => {
        labelableFeatures(fc, LABEL);
      });
      const kept = labelableFeatures(fc, LABEL).length;
      lines.push(row(`points ${count} (kept ${kept})`, stats));
    }
    console.log(
      "\nlabelableFeatures — sparse labels (1 in 10)\n" + lines.join("\n"),
    );
  });

  it("accessor pass deck re-runs over the fresh array", () => {
    const lines: string[] = [];
    for (const count of COUNTS) {
      const fc = pointCollection(count);
      const data = labelableFeatures(fc, LABEL);
      const props = deckLabelProps(LABEL);
      const getText = props.getText;
      lines.push(
        row(
          `getText + getPosition ${count}`,
          measure(REPS, () => {
            let chars = 0;
            for (const f of data) {
              chars += getText(f).length;
              labelPosition(f);
            }
            if (chars < 0) throw new Error("unreachable");
          }),
        ),
      );
    }
    console.log(
      "\nJS half of the attribute re-upload: every accessor over every kept feature\n" +
        lines.join("\n"),
    );
  });

  it("glyph-instance volume — what a TextLayer re-uploads", () => {
    const lines: string[] = [];
    const text = labelText(LABEL);
    for (const count of COUNTS) {
      const fc = pointCollection(count);
      const data = labelableFeatures(fc, LABEL);
      let glyphs = 0;
      for (const f of data) glyphs += (text(f) ?? "").length;
      // deck.gl's TextLayer expands each string to one instance per
      // character on its MultiIconLayer sublayer (the TextBackgroundLayer
      // is per string, so it does not multiply by glyph count). Declared
      // per-instance attributes, read from @deck.gl/layers' own
      // icon-layer and multi-icon-layer sources:
      //   instancePositions   size 3, float64  → 24 B (two f32 buffers)
      //   instanceSizes       size 1, f32      →  4 B
      //   instanceIconDefs    size 7, f32      → 28 B
      //   instanceColors      size 4, unorm8   →  4 B
      //   instanceAngles      size 1, f32      →  4 B
      //   instancePixelOffset size 2, f32      →  8 B
      //   instancePickingColors size 4, uint8  →  4 B
      //   instanceClipRect    size 4, f32      → 16 B
      // = 92 bytes per character instance. Arithmetic over declared
      // sizes, not a measured upload: real buffers may pad or align.
      const bytes = glyphs * 92;
      lines.push(
        `  points ${String(count).padEnd(8)} kept ${String(data.length).padEnd(
          8,
        )} glyph instances ${String(glyphs).padEnd(10)} ≈ ${(
          bytes / 1024
        ).toFixed(0)} KiB of instance attributes`,
      );
    }
    console.log(
      "\nAttribute volume invalidated per tick (GPU upload itself unmeasured here)\n" +
        lines.join("\n"),
    );
  });

  it("allocation volume per tick", () => {
    const lines: string[] = [];
    for (const count of COUNTS) {
      const fc = pointCollection(count);
      if (!globalThis.gc) {
        lines.push(`  points ${count}: --expose-gc not enabled, skipped`);
        continue;
      }
      globalThis.gc();
      const before = process.memoryUsage().heapUsed;
      const held: unknown[] = [];
      for (let i = 0; i < 10; i++) held.push(labelableFeatures(fc, LABEL));
      const after = process.memoryUsage().heapUsed;
      lines.push(
        `  points ${String(count).padEnd(8)} 10 retained rebuilds add ${(
          (after - before) /
          1024
        ).toFixed(0)} KiB → ${((after - before) / 10 / 1024).toFixed(
          1,
        )} KiB per tick (array of ${(held[0] as unknown[]).length} refs)`,
      );
      held.length = 0;
    }
    console.log("\nHeap cost of the per-tick array\n" + lines.join("\n"));
  });
});
