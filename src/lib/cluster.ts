import Supercluster from "supercluster";
import type { Aggregate } from "@/lib/viz";

/**
 * Client-side point clustering, on supercluster. Points aggregate into
 * count-labeled bubbles by a screen-pixel radius; zooming in dissolves
 * clusters toward individual points. Counts are computed from exactly the
 * rows handed in, so live-filtered layers re-cluster from the filtered rows
 * and the numbers stay truthful.
 */

export interface ClusterPoint {
  position: [number, number];
  properties: Record<string, unknown>;
}

export interface ClusterBubble {
  position: [number, number];
  /** Points inside; 1 for an unclustered leaf. */
  count: number;
  /** The aggregate value coloring rides on; null for count-less leaves
   * and empty aggregates. */
  value: number | null;
  /** Null for a leaf; set for a cluster bubble. */
  clusterId: number | null;
  /** Zoom at which this cluster breaks apart — the click target. */
  expansionZoom: number | null;
  /** Leaf: the row's own properties. Cluster: a summary for hover. */
  properties: Record<string, unknown>;
}

interface Reduced {
  __n: number;
  __sum: number;
  __min: number;
  __max: number;
  [key: string]: unknown;
}

function numeric(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) ? value : null;
}

export type ClusterIndex = Supercluster<
  Record<string, unknown>,
  Reduced
>;

export const CLUSTER_MAX_ZOOM = 20;

export function buildClusterIndex(
  points: ClusterPoint[],
  radiusPx: number,
  aggregate: Aggregate | null,
): ClusterIndex {
  const attribute = aggregate && aggregate.fn !== "count" ? aggregate.attribute : null;
  const index = new Supercluster<Record<string, unknown>, Reduced>({
    radius: radiusPx,
    maxZoom: CLUSTER_MAX_ZOOM,
    ...(attribute
      ? {
          map: (props): Reduced => {
            const v = numeric(props[attribute]);
            return {
              __n: v === null ? 0 : 1,
              __sum: v ?? 0,
              __min: v ?? Infinity,
              __max: v ?? -Infinity,
            };
          },
          reduce: (acc: Reduced, props: Reduced) => {
            acc.__n += props.__n;
            acc.__sum += props.__sum;
            acc.__min = Math.min(acc.__min, props.__min);
            acc.__max = Math.max(acc.__max, props.__max);
          },
        }
      : null),
  });
  index.load(
    points.map((p) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: p.position },
      properties: p.properties,
    })),
  );
  return index;
}

function aggregateValue(
  aggregate: Aggregate | null,
  count: number,
  reduced: Partial<Reduced>,
  leafProps?: Record<string, unknown>,
): number | null {
  if (!aggregate) return null;
  if (aggregate.fn === "count") return count;
  if (leafProps) return numeric(leafProps[aggregate.attribute]);
  const n = reduced.__n ?? 0;
  if (n === 0) return null;
  switch (aggregate.fn) {
    case "sum":
      return reduced.__sum ?? null;
    case "avg":
      return (reduced.__sum ?? 0) / n;
    case "min":
      return reduced.__min ?? null;
    case "max":
      return reduced.__max ?? null;
  }
}

/** The bubbles for one integer zoom, world-wide — pan never re-clusters. */
export function clusterBubbles(
  index: ClusterIndex,
  zoom: number,
  aggregate: Aggregate | null,
): ClusterBubble[] {
  const features = index.getClusters([-180, -85, 180, 85], zoom);
  return features.map((f) => {
    const position = f.geometry.coordinates as [number, number];
    const props = f.properties as Record<string, unknown>;
    if (props.cluster === true) {
      const clusterId = Number(props.cluster_id);
      const count = Number(props.point_count);
      const value = aggregateValue(aggregate, count, props as Partial<Reduced>);
      let expansionZoom: number | null = null;
      try {
        expansionZoom = Math.min(
          index.getClusterExpansionZoom(clusterId),
          CLUSTER_MAX_ZOOM,
        );
      } catch {
        expansionZoom = null;
      }
      return {
        position,
        count,
        value,
        clusterId,
        expansionZoom,
        properties: {
          points: count,
          ...(aggregate && aggregate.fn !== "count" && value !== null
            ? { [`${aggregate.fn} ${aggregate.attribute}`]: value }
            : null),
        },
      };
    }
    return {
      position,
      count: 1,
      value: aggregateValue(aggregate, 1, {}, props),
      clusterId: null,
      expansionZoom: null,
      properties: props,
    };
  });
}
