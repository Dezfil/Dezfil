import { authFailure, requireRequestAuth } from "@/lib/auth/http";
import {
  invalidTile,
  noImageryResponse,
  readTileCoordinate,
  relaySatelliteTile,
  tileResponse,
} from "@/lib/basemap-satellite-tiles";

type Params = { params: Promise<{ z: string; x: string; y: string }> };

/**
 * One tile of the configured imagery, for a signed-in browser drawing the
 * imagery style: fetched now by the server from the tile template and
 * passed back, so the template and its key stay here. Only the tile's z, x
 * and y reach the template, refused before anything is asked unless each
 * is a whole number inside the zoom's range. An instance with no imagery
 * answers as the style does.
 */
export async function GET(request: Request, { params }: Params) {
  try {
    requireRequestAuth(request);
    const { z, x, y } = await params;
    const tile = readTileCoordinate(z, x, y);
    if (!tile) throw invalidTile();
    const relayed = await relaySatelliteTile(tile, { signal: request.signal });
    return relayed ? tileResponse(relayed) : noImageryResponse();
  } catch (error) { return authFailure(error); }
}
