import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { mapWithLayers } from "@/lib/map-service";
import { isAggregated } from "@/lib/viz";
import { effectiveSql } from "@/lib/query/compile";
import { matches } from "@/lib/search/match";
import { parseCoordinates } from "@/lib/search/coordinates";
import { searchValues } from "@/lib/search/value-search";
import { searchPlaces } from "@/lib/search/provider";
import type { SearchResponse } from "@/lib/search/contract";

type Params = { params: Promise<{ id: string }> };

/**
 * Map search: one endpoint, the grouped result classes the builder
 * shows — layer names, attribute values, coordinate readings — so the
 * UI holds no search ability the API lacks (S-api). Visible layers
 * only, on the defaults; a layer row fits, so a hidden layer's name
 * would answer with a dead action. Value search runs each visible
 * layer's effective (filtered) query — the reader's truth, all filters
 * applied — through the guarded, bounded read-only path. Aggregated
 * layers' effective results are cells without text and are skipped as
 * such.
 */
export async function GET(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const url = new URL(request.url);
    const q = url.searchParams.get("q") ?? "";
    if (!q.trim()) {
      throw new ApiError("invalid_request", "Provide a search text as q.", 400);
    }

    const map = mapWithLayers(id);
    const visible = map.layers.filter((l) => l.visible);

    // Places join only when asked for — a submitted search (S3a): the
    // provider is never contacted per keystroke, and its failures resolve
    // inside the places group rather than costing the local answers.
    const places =
      url.searchParams.get("places") === "1" ? searchPlaces(q) : null;

    const values = await searchValues(
      visible
        .filter((l) => !isAggregated(l.viz))
        .map((l) => ({
          layerId: l.id,
          layerName: l.name,
          sql: effectiveSql(
            { sql: l.sql, filters: l.filters, viz: l.viz },
            null,
          ),
        })),
      q,
      { signal: request.signal },
    );

    const response: SearchResponse = {
      layers: visible
        .filter((l) => matches(l.name, q))
        .map((l) => ({ layerId: l.id, name: l.name, viz: l.viz.type })),
      values,
      coordinates: parseCoordinates(q),
      ...(places ? { places: await places } : {}),
    };
    return NextResponse.json(response);
  } catch (error) {
    return errorResponse(error);
  }
}
