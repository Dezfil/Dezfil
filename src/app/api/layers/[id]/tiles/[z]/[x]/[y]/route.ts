import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { requireLayer } from "@/lib/layer-service";
import { readTile } from "@/lib/tiles/serve";

type Params = { params: Promise<{ id: string; z: string; x: string; y: string }> };

function coordinate(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * One vector tile of a tiled layer. A spot the archive does not cover is an
 * empty tile (204), not an error. The render response's URL template
 * carries a version parameter, so tiles cache aggressively and a rebuild
 * busts the cache by changing the URL.
 */
export async function GET(_request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(_request);
    const { id, z, x, y } = await params;
    requireLayer(scope, id);
    const [tz, tx, ty] = [coordinate(z), coordinate(x), coordinate(y)];
    if (tz === null || tx === null || ty === null) {
      return new NextResponse(null, { status: 204 });
    }
    const tile = await readTile(id, tz, tx, ty);
    if (!tile) return new NextResponse(null, { status: 204 });
    return new NextResponse(Buffer.from(tile), {
      status: 200,
      headers: {
        "content-type": "application/vnd.mapbox-vector-tile",
        "cache-control": "private, max-age=86400",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
