import { errorResponse } from "@/lib/api/errors";
import { privateResponse } from "@/lib/auth/http";
import {
  invalidTile,
  noImageryResponse,
  readTileCoordinate,
  relaySatelliteTile,
  tileFailure,
  tileResponse,
} from "@/lib/basemap-satellite-tiles";
import { requirePublishedSatellite } from "@/lib/publish/published-satellite";
import { admitPublishedRequest } from "@/lib/publish/source-admission";

type Params = { params: Promise<{ token: string; z: string; x: string; y: string }> };

/**
 * One tile of the imagery for a published map's reader, in the tile-sized
 * rate bucket: fetched now by the server from the tile template and passed
 * back, as the signed-in tile is. The token is checked before anything is
 * asked and again once the tile has come, so a publication revoked while
 * the imagery answered passes nothing back.
 */
export async function GET(request: Request, { params }: Params) {
  try {
    admitPublishedRequest(request, "tile");
    const { token, z, x, y } = await params;
    if (requirePublishedSatellite(token) === "none") return noImageryResponse();
    const tile = readTileCoordinate(z, x, y);
    if (!tile) throw invalidTile();
    const relayed = await relaySatelliteTile(tile, { signal: request.signal });
    if (!relayed || requirePublishedSatellite(token) === "none") return noImageryResponse();
    return tileResponse(relayed);
  } catch (error) {
    return tileFailure(error, (failure) => privateResponse(errorResponse(failure)));
  }
}
