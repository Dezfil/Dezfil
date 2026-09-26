import {
  hexBoundary,
  hexCellAt,
  hexCenter,
  mercator,
  unmercator,
} from "@/lib/hex-bin";
import { timeToMs } from "@/lib/time";
import { AGG_ELEV } from "@/lib/viz";
import type {
  Aggregate,
  AggregatedViz,
  LayerFilter,
  LayerViz,
} from "@/lib/viz";

export interface SliderPreviewField {
  name: string;
  kind: "numeric" | "time" | "text";
}

/** Bounded interaction input returned by the read-only preview endpoint. */
export interface SliderPreviewData {
  layerId: string;
  exact: boolean;
  sourceCount: number;
  sampledCount: number;
  budget: number;
  fields: SliderPreviewField[];
  geojson: unknown;
}

interface PreviewFeature {
  type: "Feature";
  geometry: {
    type: string;
    coordinates: unknown;
  };
  properties: Record<string, unknown>;
}

export interface SliderPreviewResult {
  geojson: { type: "FeatureCollection"; features: PreviewFeature[] };
  approximate: boolean;
  sourceCount: number;
  sampledCount: number;
}

export interface SliderPreviewWork {
  id: number;
  source: SliderPreviewData;
  viz: LayerViz;
  filters: LayerFilter[];
}

export type SliderPreviewWorkResult =
  | { id: number; ok: true; result: SliderPreviewResult }
  | { id: number; ok: false; error: string };

function previewFeatures(source: SliderPreviewData): PreviewFeature[] {
  const collection = source.geojson as { features?: PreviewFeature[] };
  return collection.features ?? [];
}

function numeric(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** Slider-filter predicate with the same inclusive/open/NULL rules as SQL. */
export function passesSliderFilters(
  properties: Record<string, unknown>,
  filters: LayerFilter[],
): boolean {
  for (const filter of filters) {
    // Value filters were applied before the preview source was bounded.
    if (filter.kind === "values") continue;
    if (filter.min === null && filter.max === null) continue;
    if (filter.kind === "range") {
      const value = numeric(properties[filter.field]);
      if (value === null) return false;
      if (filter.min !== null && value < filter.min) return false;
      if (filter.max !== null && value > filter.max) return false;
    } else {
      const value = timeToMs(properties[filter.field]);
      if (value === timeToMs(null)) return false;
      const min = filter.min === null ? null : timeToMs(filter.min);
      const max = filter.max === null ? null : timeToMs(filter.max);
      if (min !== null && value < min) return false;
      if (max !== null && value > max) return false;
    }
  }
  return true;
}

/** Range/time filtering for non-aggregated preview fallbacks. */
export function filterSliderPreview(
  source: SliderPreviewData,
  filters: LayerFilter[],
): SliderPreviewResult {
  return {
    geojson: {
      type: "FeatureCollection",
      features: previewFeatures(source).filter((feature) =>
        passesSliderFilters(feature.properties, filters),
      ),
    },
    approximate: !source.exact,
    sourceCount: source.sourceCount,
    sampledCount: source.sampledCount,
  };
}

interface CellSeed {
  key: string;
  geometry: PreviewFeature["geometry"];
  anchor: [number, number];
}

function cellFor(
  position: [number, number],
  viz: AggregatedViz,
): CellSeed {
  if (viz.type === "hexbin") {
    const edge = viz.cellKm * 1000;
    const [hx, hy] = mercator(position);
    const cell = hexCellAt(hx, hy, edge);
    return {
      key: `${cell.q}:${cell.r}`,
      geometry: {
        type: "Polygon",
        coordinates: [hexBoundary(cell, edge).map(unmercator)],
      },
      anchor: unmercator(hexCenter(cell, edge)),
    };
  }
  const size = viz.cellKm * 1000;
  const [x, y] = mercator(position);
  const x0 = Math.floor(x / size) * size;
  const y0 = Math.floor(y / size) * size;
  const x1 = x0 + size;
  const y1 = y0 + size;
  return {
    key: `${x0}:${y0}`,
    geometry: {
      type: "Polygon",
      coordinates: [[
        unmercator([x0, y0]),
        unmercator([x1, y0]),
        unmercator([x1, y1]),
        unmercator([x0, y1]),
        unmercator([x0, y0]),
      ]],
    },
    anchor: unmercator([(x0 + x1) / 2, (y0 + y1) / 2]),
  };
}

interface AggStats {
  numericCount: number;
  sum: number;
  min: number;
  max: number;
}

function newStats(): AggStats {
  return { numericCount: 0, sum: 0, min: Infinity, max: -Infinity };
}

function accumulate(stats: AggStats, value: number | null): void {
  if (value === null) return;
  stats.numericCount += 1;
  stats.sum += value;
  stats.min = Math.min(stats.min, value);
  stats.max = Math.max(stats.max, value);
}

interface CellAccumulator extends CellSeed {
  count: number;
  value: AggStats;
  elev: AggStats;
}

function aggregateValue(
  aggregate: Aggregate,
  stats: AggStats,
  count: number,
  scale: number,
): number | null {
  if (aggregate.fn === "count") return count;
  if (stats.numericCount === 0) return null;
  switch (aggregate.fn) {
    case "sum":
      return stats.sum * scale;
    case "avg":
      return stats.sum / stats.numericCount;
    case "min":
      return stats.min;
    case "max":
      return stats.max;
  }
}

/** Exact or bounded local re-aggregation for hex-bin and grid previews. */
export function aggregateSliderPreview(
  source: SliderPreviewData,
  viz: AggregatedViz,
  filters: LayerFilter[],
): SliderPreviewResult {
  const cells = new Map<string, CellAccumulator>();
  for (const feature of previewFeatures(source)) {
    if (
      feature.geometry.type !== "Point" ||
      !passesSliderFilters(feature.properties, filters)
    ) {
      continue;
    }
    const seed = cellFor(
      feature.geometry.coordinates as [number, number],
      viz,
    );
    let cell = cells.get(seed.key);
    if (!cell) {
      cell = { ...seed, count: 0, value: newStats(), elev: newStats() };
      cells.set(seed.key, cell);
    }
    cell.count += 1;
    if (viz.aggregate.fn !== "count") {
      accumulate(cell.value, numeric(feature.properties[viz.aggregate.attribute]));
    }
    const elevAggregate = viz.elevation?.aggregate;
    if (elevAggregate && elevAggregate.fn !== "count") {
      accumulate(cell.elev, numeric(feature.properties[elevAggregate.attribute]));
    }
  }

  const scale = source.exact || source.sampledCount === 0
    ? 1
    : source.sourceCount / source.sampledCount;
  const features = [...cells.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((cell): PreviewFeature => {
      const count = Math.round(cell.count * scale);
      return {
        type: "Feature",
        geometry: cell.geometry,
        properties: {
          value: aggregateValue(viz.aggregate, cell.value, count, scale),
          count,
          // Extruded previews keep rising: the reserved elevation value
          // re-aggregates locally like the cell value.
          ...(viz.elevation
            ? {
                [AGG_ELEV]: aggregateValue(
                  viz.elevation.aggregate,
                  cell.elev,
                  count,
                  scale,
                ),
              }
            : null),
          __anchor: cell.anchor,
        },
      };
    });
  return {
    geojson: { type: "FeatureCollection", features },
    approximate: !source.exact,
    sourceCount: source.sourceCount,
    sampledCount: source.sampledCount,
  };
}

export function runSliderPreviewWork(
  work: SliderPreviewWork,
): SliderPreviewResult {
  return work.viz.type === "hexbin" || work.viz.type === "grid"
    ? aggregateSliderPreview(work.source, work.viz, work.filters)
    : filterSliderPreview(work.source, work.filters);
}
