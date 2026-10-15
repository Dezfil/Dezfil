import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { privateResponse } from "@/lib/auth/http";
import { publishedSatelliteStyleUrl } from "@/lib/basemap";
import { satelliteStyleDocument } from "@/lib/basemap-satellite";
import { noImageryResponse } from "@/lib/basemap-satellite-tiles";
import { requirePublishedSatellite } from "@/lib/publish/published-satellite";
import { admitPublishedRequest } from "@/lib/publish/source-admission";

type Params = { params: Promise<{ token: string }> };

/**
 * The imagery style as a published map's reader loads it: the signed-in
 * style's document, its tiles at this publication's own address, so a
 * reader who is not signed in draws the imagery and no part of the tile
 * template reaches them. Charged to the view budget like the published
 * view, and refused as the published layer tiles refuse once the token is
 * revoked or unknown, or where the publication's reader is not shown
 * Satellite.
 */
export async function GET(request: Request, { params }: Params) {
  try {
    admitPublishedRequest(request);
    const { token } = await params;
    if (requirePublishedSatellite(token) === "none") return noImageryResponse();
    const style = satelliteStyleDocument(publishedSatelliteStyleUrl(token));
    if (!style) return noImageryResponse();
    return privateResponse(NextResponse.json(style));
  } catch (error) {
    return privateResponse(errorResponse(error));
  }
}
