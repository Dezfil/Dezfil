/**
 * Write-time column-reference validation. The API refuses a write that
 * introduces or changes a reference to a column the layer's result does
 * not provide — or provides with a kind the channel cannot draw — while
 * untouched stored references pass through (the echo contract) and
 * read-time drift degradation stays exactly as it is.
 *
 * Everything here is pure and synchronous: the services resolve the
 * layer's result schema (the same capability the read paths use) and
 * hand it in, so the rule tests trivially and cannot drift between
 * callers.
 */

import type {
  FieldKind,
  LayerFieldsResult,
} from "@/lib/layer-service";
import type { LayerFilter, LayerViz, Aggregate } from "@/lib/viz";
import type { FillPaint, LayerStyle, SizeScale } from "@/lib/style/style";
import type { MapWidget } from "@/lib/widgets";

/** Entry cap for the column-list surfaces (tooltip, pop-up, published
 * fields) — same order as the peer caps (16 filters, 24 legend entries,
 * 12 widgets), comfortably above any legitimate use (plan gate). */
export const MAX_FIELD_LIST = 32;

/** One column reference a request carries: where it draws from, what
 * kind the channel needs ("any" = existence only), and where it sits —
 * the channel names the refusal. */
export interface ColumnRef {
  family: "styling" | "filterable" | "geometry";
  needs: FieldKind | "any";
  name: string;
  channel: string;
}

function paintRefs(paint: FillPaint | undefined, channel: string): ColumnRef[] {
  if (!paint || paint.type === "constant") return [];
  return [
    {
      family: "styling",
      // Ramp fills bucket or interpolate numbers; categorical takes any.
      needs: paint.type === "categorical" ? "any" : "numeric",
      name: paint.attribute,
      channel,
    },
  ];
}

function scaleRefs(
  scale: SizeScale | undefined,
  channel: string,
): ColumnRef[] {
  if (!scale) return [];
  return [{ family: "styling", needs: "numeric", name: scale.attribute, channel }];
}

/** References a style carries. */
export function styleRefs(style: LayerStyle): ColumnRef[] {
  const refs: ColumnRef[] = [
    ...paintRefs(style.fill, "fill"),
    ...paintRefs(style.strokeBy, "stroke color"),
    ...scaleRefs(style.pointRadiusBy, "point radius"),
    ...scaleRefs(style.strokeWidthBy, "stroke width"),
    ...scaleRefs(style.heightBy, "extrusion height"),
  ];
  if (style.label?.attribute !== undefined) {
    refs.push({
      family: "styling",
      needs: "any",
      name: style.label.attribute,
      channel: "label",
    });
  }
  // The thinning priority is a numeric reference: ranking a column the
  // result cannot honor would silently sort on nothing.
  if (style.label?.priorityField != null) {
    refs.push({
      family: "styling",
      needs: "numeric",
      name: style.label.priorityField,
      channel: "label priority",
    });
  }
  return refs;
}

function aggregateRefs(
  aggregate: Aggregate | undefined,
  channel: string,
): ColumnRef[] {
  if (!aggregate || aggregate.fn === "count") return [];
  return [
    {
      family: "filterable",
      needs: "numeric",
      name: aggregate.attribute,
      channel,
    },
  ];
}

/** References a visualization carries.
 * Aggregations, weights and endpoints read the layer's own result — the
 * base columns — while an aggregated fill colors the derived value. */
export function vizRefs(viz: LayerViz): ColumnRef[] {
  switch (viz.type) {
    case "hexbin":
    case "grid":
      return [
        ...aggregateRefs(viz.aggregate, "aggregation"),
        ...aggregateRefs(viz.elevation?.aggregate, "elevation aggregation"),
        ...paintRefs(viz.fill, "cell fill"),
      ];
    case "heatmap":
      return viz.weight === null
        ? []
        : [
            {
              family: "filterable",
              needs: "numeric",
              name: viz.weight,
              channel: "heatmap weight",
            },
          ];
    case "arc":
    case "line": {
      const refs: ColumnRef[] = [];
      for (const [end, endpoint] of [
        ["origin", viz.origin],
        ["destination", viz.dest],
      ] as const) {
        if (endpoint?.kind === "geometry") {
          refs.push({
            family: "geometry",
            needs: "any",
            name: endpoint.field,
            channel: `${end} endpoint`,
          });
        } else if (endpoint?.kind === "lonlat") {
          refs.push(
            {
              family: "filterable",
              needs: "numeric",
              name: endpoint.lon,
              channel: `${end} endpoint longitude`,
            },
            {
              family: "filterable",
              needs: "numeric",
              name: endpoint.lat,
              channel: `${end} endpoint latitude`,
            },
          );
        }
      }
      return refs;
    }
    case "cluster":
      return viz.color === "fixed"
        ? []
        : aggregateRefs(viz.color, "cluster color aggregation");
    default:
      return [];
  }
}

/** References the filters carry: the control kind decides the field kind
 * ranges span numbers, time ranges span time, value sets apply
 * anywhere. */
export function filterRefs(filters: LayerFilter[]): ColumnRef[] {
  return filters.map((f) => ({
    family: "filterable",
    needs: f.kind === "range" ? "numeric" : f.kind === "timerange" ? "time" : "any",
    name: f.field,
    channel: `${f.kind} filter`,
  }));
}

/** References a column-name list carries (tooltip, pop-up, published
 * fields) — existence only, in the family the list draws from. */
export function listRefs(
  list: string[] | null | undefined,
  family: "styling" | "filterable",
  channel: string,
): ColumnRef[] {
  return (list ?? []).map((name) => ({ family, needs: "any", name, channel }));
}

/** References a widget carries against its bound layer's result
 * histograms and non-count formulas aggregate numbers; category
 * grouping keys take any column; a category ranking field aggregates
 * numbers. Notes read nothing. */
export function widgetRefs(widget: MapWidget): ColumnRef[] {
  if (widget.type === "note") return [];
  const where = `widget "${widget.title}"`;
  const refs: ColumnRef[] = [];
  if (widget.field !== null) {
    refs.push({
      family: "filterable",
      needs:
        widget.type === "histogram" ||
        (widget.type === "formula" && widget.agg !== "count")
          ? "numeric"
          : "any",
      name: widget.field,
      channel: `${where} field`,
    });
  }
  if (widget.aggField !== null) {
    refs.push({
      family: "filterable",
      needs: "numeric",
      name: widget.aggField,
      channel: `${where} ranking field`,
    });
  }
  return refs;
}

function refKey(ref: ColumnRef): string {
  return `${ref.family}\u0000${ref.needs}\u0000${ref.name}\u0000${ref.channel}`;
}

/** The references a request introduces or changes: incoming minus the
 * stored set, compared as whole tuples — so a stale reference echoed
 * unchanged passes through, while the same column bound to a new channel
 * or a new kind requirement validates. */
export function changedRefs(
  incoming: ColumnRef[],
  stored: ColumnRef[],
): ColumnRef[] {
  const seen = new Set(stored.map(refKey));
  return incoming.filter((ref) => !seen.has(refKey(ref)));
}

/**
 * Why the references cannot be honored against the resolved schema, in
 * one sentence — or null when every reference resolves. Mirrors the
 * shape validators' problem-sentence convention.
 */
export function refProblem(
  refs: ColumnRef[],
  fields: LayerFieldsResult,
): string | null {
  for (const ref of refs) {
    if (ref.family === "geometry") {
      if (!fields.geometryColumns.includes(ref.name)) {
        return `The ${ref.channel} references "${ref.name}", which is not a geometry column of the layer's result.`;
      }
      continue;
    }
    const pool = ref.family === "styling" ? fields.styling : fields.filterable;
    const found = pool.find((f) => f.name === ref.name);
    if (!found) {
      return `The ${ref.channel} references column "${ref.name}", which the layer's result does not provide.`;
    }
    if (ref.needs !== "any" && found.kind !== ref.needs) {
      return `The ${ref.channel} needs a ${ref.needs} column; "${ref.name}" is ${found.kind}.`;
    }
  }
  return null;
}
