import type { Layer } from "@/lib/metadata/maps";
import type { DatasetScope } from "@/lib/query/access";
import { isBoundedOutcome } from "@/lib/query/bounded";
import { effectiveSql } from "@/lib/query/compile";
import type { FillPaint, LayerStyle } from "@/lib/style/style";
import { ApiError } from "@/lib/api/errors";
import { classifyFill, paletteAvailable, type ClassifyMethod, type ClassifyOptions } from "@/lib/style/classify";
import { automaticMethod, wholeNumberField } from "@/lib/style/default-method";
import {
  AGG_VALUE,
  isAggregated,
  type AggregatedViz,
  type LayerFilter,
} from "@/lib/viz";

/**
 * The server's own fill for an aggregated layer: classified over the
 * aggregate value whenever the aggregation or its filters reshape the
 * values, carrying the prior paint's choices. Out of the layer update path
 * under the decomposition rule, with the same behaviour.
 */

/** Ramp choices worth carrying across aggregation changes. */
export function priorAggregatedFill(layer: Layer): FillPaint | undefined {
  if (isAggregated(layer.viz)) return layer.viz.fill;
  // Entering aggregation from a simple visualization is a type switch: the
  // fill's ramp choices — scale mode, palette, reverse — survive where they
  // still apply. Categorical fills don't: the aggregate value is numeric,
  // so they fall back to the default ramp as before.
  return layer.style.fill.type === "quantile" ||
    layer.style.fill.type === "continuous"
    ? layer.style.fill
    : undefined;
}

/**
 * The palette a reclassification carries over from the prior fill. A saved
 * palette deleted since the layer was styled cannot be asked for by name:
 * the layer's own stored colors stand in for it (the fill keeps the name),
 * or, with none stored, the default palette does.
 */
function priorPalette(prior: FillPaint | undefined): Pick<ClassifyOptions, "palette" | "colors"> {
  if (!prior || prior.type === "constant") return {};
  const kind = prior.type === "categorical" ? "categorical" : "sequential";
  if (paletteAvailable(prior.palette, kind)) return { palette: prior.palette };
  const own = prior.type === "quantile" ? { stops: prior.colors }
    : prior.type === "continuous" ? { stops: prior.stops, positions: prior.positions }
      : null;
  return own && own.stops.length > 0 ? { palette: prior.palette, colors: own } : {};
}

/**
 * Fill for an aggregated layer, classified over the aggregate value. When
 * classification cannot run (empty result, missing extension), fall back to
 * a constant so the layer stays usable — render reports its own errors.
 */
export async function aggregatedFill(
  scope: DatasetScope,
  input: { sql: string; filters: LayerFilter[]; viz: AggregatedViz },
  geometryColumn: string,
  prior: FillPaint | undefined,
  style: LayerStyle,
  signal?: AbortSignal,
): Promise<FillPaint> {
  const fallback: FillPaint =
    style.fill.type === "constant"
      ? style.fill
      : { type: "constant", color: { r: 18, g: 147, b: 154, a: 1 } };
  try {
    const sql = effectiveSql(input, geometryColumn);
    const priorRamp = prior?.type === "quantile" ? prior : undefined;
    const priorCategorical = prior?.type === "categorical" ? prior : undefined;
    const priorContinuous = prior?.type === "continuous" ? prior : undefined;
    // A custom scale reclassifies from its base method — the aggregation
    // changed, so hand-set breaks no longer describe the values. With no
    // numeric paint to carry, the fill starts on the method its values
    // suit.
    const automatic = !priorRamp && !priorCategorical && !priorContinuous;
    const priorMethod: ClassifyMethod = priorCategorical
      ? "categorical"
      : priorContinuous
        ? "continuous"
        : automatic
          ? automaticMethod(wholeNumberField(input.viz, { name: AGG_VALUE }))
          : priorRamp?.method === "custom"
            ? (priorRamp.baseMethod ?? "quantile")
            : (priorRamp?.method ?? "quantile");
    const classify = (method: ClassifyMethod) => classifyFill(scope,
      sql,
      AGG_VALUE,
      method,
      {
        ...priorPalette(prior),
        classes: priorRamp?.classes ?? priorRamp?.colors.length,
        reversed:
          priorCategorical?.reversed ??
          priorContinuous?.reversed ??
          priorRamp?.reversed,
      },
      signal,
    );
    const fresh = await classify(priorMethod).catch(async (error: unknown) => {
      // Natural finds no boundary in values that are all the same, which
      // Quantile still classifies: the automatic choice asks it instead.
      // A Natural the paint already holds keeps its name over Quantile's
      // classes, so the next reclassification (a filter lifted, a cell
      // size changed) asks Natural again. Any other failure stands.
      const refused = error instanceof ApiError && error.code === "invalid_request";
      if (priorMethod !== "natural" || !refused) throw error;
      const quantile = await classify("quantile");
      return automatic || quantile.type !== "quantile" ? quantile : { ...quantile, method: "natural" as const };
    });
    // The scale mode survives reclassification; value-anchored adjustments
    // (clamp, center) re-derive from the new distribution, and log carries
    // over only while the fresh domain still supports it.
    if (
      fresh.type === "continuous" &&
      priorContinuous?.log === true &&
      fresh.domain[0] > 0
    ) {
      return { ...fresh, log: true };
    }
    return fresh;
  } catch (error) {
    // Same rule as settledElevation: the bound's outcomes propagate; only
    // genuine classification failures degrade to the constant fallback.
    if (isBoundedOutcome(error)) throw error;
    return fallback;
  }
}

/**
 * Reclassification caused by an authoritative filter change. An explicit
 * constant is user intent, not an automatic scale, so it survives unchanged;
 * every data-driven fill follows the established aggregate reclassification
 * path (including Custom returning to its remembered named method).
 */
export async function filterSettledAggregatedFill(
  scope: DatasetScope,
  input: { sql: string; filters: LayerFilter[]; viz: AggregatedViz },
  geometryColumn: string,
  prior: FillPaint | undefined,
  style: LayerStyle,
  signal?: AbortSignal,
): Promise<FillPaint> {
  if (prior?.type === "constant") return prior;
  return aggregatedFill(scope, input, geometryColumn, prior, style, signal);
}

