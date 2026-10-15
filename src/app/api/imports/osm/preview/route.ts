import { largeJsonValue } from "@/lib/api/json-body";
import { NextResponse } from "next/server";
import { errorResponse, ApiError } from "@/lib/api/errors";
import { previewOsm } from "@/lib/osm/import";

/** Run Query for OSM: the features an import with the
 * same body would land — the identical Overpass fetch (cached), assembly,
 * and within filter — as GeoJSON capped by the render cap. */
export async function POST(request: Request) {
  try {
    const body = (await largeJsonValue(request, () => null)) as Record<
      string,
      unknown
    > | null;
    if (!body) {
      throw new ApiError(
        "invalid_request",
        "Expected a JSON body with selectors + an area, or a raw ql query.",
        400,
      );
    }
    return NextResponse.json(
      await previewOsm({
        selectors: body.selectors,
        ql: body.ql,
        bbox: body.bbox,
        ring: body.ring,
        geometry: body.geometry,
        semantics: body.semantics,
        name: body.name,
      }, request.signal),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
