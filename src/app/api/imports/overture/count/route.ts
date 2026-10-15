import { withTrustedOperation } from "@/lib/trusted-operation";
import { largeJsonValue } from "@/lib/api/json-body";
import { NextResponse } from "next/server";
import { errorResponse, ApiError } from "@/lib/api/errors";
import {
  countOverture,
  countOvertureLevels,
  resolveOvertureParams,
} from "@/lib/overture/import";

/** Count what an import would land, before it does — same resolution, same
 * filter, so the preview matches the import. Returns the source query for
 * the read-only dev-mode display. With byLevel (divisions only) it returns
 * every level's scoped count in one call instead of a single number. */
export async function POST(request: Request) {
  try {
    return await withTrustedOperation({ kind: "interactive-read", name: "Overture read", signal: request.signal }, async () => {
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
    if (body.byLevel !== undefined && typeof body.byLevel !== "boolean") {
      throw new ApiError(
        "invalid_request",
        "byLevel must be a boolean.",
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
    if (body.byLevel === true) {
      const { levels, query } = await countOvertureLevels(params);
      return NextResponse.json({ levels, ...(query ? { query } : {}) });
    }
    const { count, query } = await countOverture(params);
    return NextResponse.json({ count, query });
    });
  } catch (error) {
    return errorResponse(error);
  }
}
