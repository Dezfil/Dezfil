import { largeJsonValue } from "@/lib/api/json-body";
import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { dimsToFilters } from "@/lib/extent-dims";
import { layerExtent } from "@/lib/extent-service";
import { requireLayer } from "@/lib/layer-access";
import { requireRequestScope } from "@/lib/auth/scope-http";
import type { LiveDim } from "@/lib/live-filters";

type Params = { params: Promise<{ id: string }> };

/** Every dimension, checked before anything is translated. An API client
 * is a first-class caller here, so a malformed dimension answers the
 * documented code rather than reaching the engine and returning a 500. */
function parseDims(value: unknown): LiveDim[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ApiError("invalid_request", "`dims` must be a list.", 400);
  }
  return value.map((raw, i) => {
    const dim = raw as Partial<LiveDim>;
    const at = `dims[${i}]`;
    if (!dim || typeof dim.field !== "string" || dim.field === "") {
      throw new ApiError("invalid_request", `${at} needs a field.`, 400);
    }
    if (
      dim.kind !== "range" &&
      dim.kind !== "timerange" &&
      dim.kind !== "values"
    ) {
      throw new ApiError(
        "invalid_request",
        `${at}.kind accepts range, timerange or values.`,
        400,
      );
    }
    if (
      !Array.isArray(dim.range) ||
      dim.range.length !== 2 ||
      !dim.range.every((n) => typeof n === "number" && Number.isFinite(n))
    ) {
      throw new ApiError(
        "invalid_request",
        `${at}.range must be two finite numbers.`,
        400,
      );
    }
    if (dim.kind === "values") {
      if (
        !Array.isArray(dim.values) ||
        !dim.values.every((v) => typeof v === "string")
      ) {
        throw new ApiError(
          "invalid_request",
          `${at}.values must be a list of strings.`,
          400,
        );
      }
    }
    return dim as LiveDim;
  });
}

/**
 * A layer's current data extent — the layer's own query under the
 * constraints the canvas is enforcing. The browser answers this itself
 * whenever it holds the layer's features whole; this exists for the case
 * it cannot, a tiled layer whose features never reach it entire.
 *
 * Empty is a distinct outcome from a failure: filtering everything away is
 * a normal thing to do, and it must not read as a broken extent.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    const { id } = await params;
    const layer = requireLayer(scope, id);
    const body = (await largeJsonValue(request, () => ({}))) as {
      dims?: unknown;
    };
    const dims = parseDims(body.dims);
    const extent = await layerExtent(scope, layer, dimsToFilters(dims), request.signal);
    return NextResponse.json(extent);
  } catch (error) {
    return errorResponse(error);
  }
}
