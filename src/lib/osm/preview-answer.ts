import osmtogeojson from "osmtogeojson";
import { ApiError } from "@/lib/api/errors";
import { RenderBudget } from "@/lib/query/render-budget";
import { jsonBytes } from "@/lib/query/result-budget";
import { featureBytes } from "./feature-bytes";
import { featureClass, featureWithin, shapeFeature, type BuiltFeature, type ShapedFeature, type WithinShape } from "./geometry";
import { planPreview } from "./preview-plan";

/** A Run Query result: the features the matching import would land, the
 * points first, then the lines, then the polygons, capped by the render cap
 * with truncation stated. */
export interface OsmFeaturePreview {
  geojson: { type: "FeatureCollection"; features: unknown[] };
  featureCount: number;
  truncated: boolean;
  cap: number;
}

/** Thrown from the callback once the answer is decided, so the remaining
 * features are never assembled. */
class Decided extends Error {}

/** Why a query does not preview over Bytes drawn per layer. The import
 * itself is not held to that limit, which is the surprise worth naming. */
function osmBytesRefusal(limit: number): ApiError {
  return new ApiError(
    "render_bytes_exceeded",
    `This query's features are larger than ${limit.toLocaleString("en-US")} bytes, the limit for one layer drawn in the map, too large to preview here. Importing them is not affected.`,
    422,
  );
}

/**
 * The preview of an Overpass response, built while its features are
 * assembled one at a time rather than after the whole collection exists.
 *
 * The answer holds the points, then the lines, then the polygons, each in
 * the import's order, after the within filter, up to the render cap. The
 * assembler hands over every point before any line or polygon, and its
 * lines and polygons interleave, so points and lines are placed and
 * counted against Bytes drawn per layer as they arrive, and a polygon is
 * held only while it can still be in the answer and still fits beside what
 * is counted: a later line can push it out, never pull an earlier one in.
 * The count is exact: every byte of the eventual JSON, envelope included,
 * and equality is admitted. A feature is measured before any of it is
 * serialized, its tags counted with their escaping, and serialized only
 * once it is in the answer. Assembly stops as soon as a placed point or
 * line takes the answer over the limit, or once the answer is complete and
 * more features are known to exist; a polygon that does not fit is let go
 * at once, and refuses the preview only if it would have been in it. Over
 * the limit the preview is refused whole with 422 render_bytes_exceeded.
 * A line or polygon too large for the answer on its own is never built:
 * it comes from a stand-in that carries its measured size (see
 * preview-plan), and is placed by that size.
 */
export function osmPreviewAnswer(
  response: unknown,
  promoted: string[],
  within: WithinShape | null,
  cap: number,
  limit: number,
  check: () => void,
): OsmFeaturePreview {
  const compose = (features: ShapedFeature[], count: number, truncated: boolean): OsmFeaturePreview => ({
    geojson: { type: "FeatureCollection", features },
    featureCount: count,
    truncated,
    cap,
  });
  const budget = new RenderBudget(limit);
  try {
    const envelope = Math.min(jsonBytes(compose([], 0, false)), jsonBytes(compose([], 0, true)));
    budget.take(envelope);
    check();
    const plan = planPreview(response, promoted, within, limit - envelope);

    // Points and lines in the answer, counted.
    const placed: ShapedFeature[] = [];
    // The polygons that can still be in the answer and fit, in order, with
    // their own bytes; their separators are counted as they would be now.
    const held: { feature: BuiltFeature; bytes: number }[] = [];
    let heldBytes = 0;
    let polygons = 0;
    // The first polygon that could be in the answer but did not fit.
    let overflow = Number.POSITIVE_INFINITY;
    let more = false;

    const heldCost = () => heldBytes + Math.max(0, held.length - (placed.length ? 0 : 1));
    const fits = () => budget.spent + heldCost() <= limit;
    // Polygons past the cap, then polygons past the bytes, leave the held run.
    const settle = () => {
      while (held.length > Math.max(0, cap - placed.length)) {
        heldBytes -= held.pop()!.bytes;
        more = true;
      }
      while (held.length && !fits()) {
        heldBytes -= held.pop()!.bytes;
        overflow = Math.min(overflow, held.length);
      }
      if (placed.length >= cap && more) throw new Decided();
    };

    try {
      // Each feature is handed over as it is built; none is kept.
      osmtogeojson(plan.response, { flatProperties: false }, (built) => {
        check();
        if (plan.added(built)) return;
        const cls = featureClass(built);
        if (!cls || (within && !featureWithin(built, within))) return;
        const size = () => plan.sized(built) ?? featureBytes(built, promoted);
        if (cls === "polygons") {
          const index = polygons++;
          if (placed.length + index >= cap) more = true;
          else if (index === held.length && index < overflow) {
            const bytes = size();
            held.push({ feature: built, bytes });
            heldBytes += bytes;
            if (!fits()) {
              heldBytes -= held.pop()!.bytes;
              overflow = index;
            }
          }
        } else if (placed.length >= cap) {
          more = true;
        } else {
          budget.take((placed.length ? 1 : 0) + size());
          placed.push(shapeFeature(built, promoted)!.shaped);
        }
        settle();
      });
    } catch (error) {
      if (!(error instanceof Decided)) throw error;
    }

    const inAnswer = Math.min(polygons, Math.max(0, cap - placed.length));
    if (inAnswer > overflow) throw osmBytesRefusal(limit);
    const features = [...placed];
    for (const { feature, bytes } of held.slice(0, inAnswer)) {
      budget.take((features.length ? 1 : 0) + bytes);
      features.push(shapeFeature(feature, promoted)!.shaped);
    }
    const truncated = more || polygons > inAnswer;
    budget.take(jsonBytes(compose([], features.length, truncated)) - envelope);
    return compose(features, features.length, truncated);
  } catch (error) {
    if (error instanceof ApiError && error.code === "render_bytes_exceeded") throw osmBytesRefusal(limit);
    throw error;
  }
}
