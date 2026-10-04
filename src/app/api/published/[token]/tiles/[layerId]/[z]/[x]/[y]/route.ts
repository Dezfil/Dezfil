import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { admitPublishedRequest } from "@/lib/publish/source-admission";
import { readTile } from "@/lib/tiles/serve";
import {
  currentPublishedTile,
  samePublishedTile,
} from "@/lib/tiles/published";

type Params = {
  params: Promise<{
    token: string;
    layerId: string;
    z: string;
    x: string;
    y: string;
  }>;
};

function coordinate(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * One vector tile of a published map's layer: read-only under the token,
 * in the tile-sized rate bucket. Unpublishing stops the token resolving,
 * which severs tile access with it — no cache to purge, the check runs on
 * every request.
 */
export async function GET(request: Request, { params }: Params) {
  try {
    const { token, layerId, z, x, y } = await params;

    admitPublishedRequest(request, "tile");

    const requestedVersion = new URL(request.url).searchParams.get("v");
    const artifact = currentPublishedTile(token, layerId, requestedVersion);
    if (!artifact) {
      throw new ApiError("not_found", "This map is not available.", 404);
    }

    const cacheHeaders = {
      "cache-control": "private, no-cache, must-revalidate",
      etag: artifact.etag,
    };
    const ifNoneMatch = request.headers.get("if-none-match");
    if (
      ifNoneMatch &&
      (ifNoneMatch.trim() === "*" ||
        ifNoneMatch.split(",").some((tag) => tag.trim() === artifact.etag))
    ) {
      return new NextResponse(null, { status: 304, headers: cacheHeaders });
    }

    const [tz, tx, ty] = [coordinate(z), coordinate(x), coordinate(y)];
    if (tz === null || tx === null || ty === null) {
      return new NextResponse(null, { status: 204, headers: cacheHeaders });
    }
    const tile = await readTile(layerId, tz, tx, ty);
    const afterRead = currentPublishedTile(token, layerId, requestedVersion);
    if (!samePublishedTile(artifact, afterRead)) {
      throw new ApiError("not_found", "This map is not available.", 404);
    }
    if (!tile) {
      return new NextResponse(null, { status: 204, headers: cacheHeaders });
    }
    return new NextResponse(Buffer.from(tile), {
      status: 200,
      headers: {
        "content-type": "application/vnd.mapbox-vector-tile",
        ...cacheHeaders,
      },
    });
  } catch (error) {
    const response = errorResponse(error);
    response.headers.set("cache-control", "private, no-store");
    return response;
  }
}
