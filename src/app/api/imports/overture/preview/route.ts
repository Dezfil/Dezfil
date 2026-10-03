import { largeJsonValue } from "@/lib/api/json-body";
import { NextResponse } from "next/server";
import { errorResponse, ApiError } from "@/lib/api/errors";
import {
  previewOvertureFeatures,
  resolveOvertureParams,
} from "@/lib/overture/import";

/** Run Query for Overture: the features an import with
 * the same body would land, as GeoJSON — capped by the render cap, with
 * truncation stated — so a selection can be seen before it is imported. */
export async function POST(request: Request) {
  try {
    const body = (await largeJsonValue(request, () => null)) as Record<
      string,
      unknown
    > | null;
    if (!body) {
      throw new ApiError(
        "invalid_request",
        "Expected a JSON body with theme and a scope.",
        400,
      );
    }
    const params = await resolveOvertureParams({
      theme: body.theme,
      scope: body.scope,
      semantics: body.semantics,
      level: body.level,
      bbox: body.bbox,
      release: body.release,
      category: body.category,
    });
    return NextResponse.json(await previewOvertureFeatures(params));
  } catch (error) {
    return errorResponse(error);
  }
}
