import { NextResponse } from "next/server";
import { satelliteStyleDocument } from "@/lib/basemap-satellite";
import { noImageryResponse } from "@/lib/basemap-satellite-tiles";
import { authFailure, privateResponse, requireRequestAuth } from "@/lib/auth/http";

/**
 * The configured imagery style. Nothing ships with a satellite service
 * attached, so this answers only where an instance configured one. The
 * style names the instance's own tile address, which the server answers
 * from the template, so the template and its key never leave the server.
 * It answers a signed-in request only (a published page's reader has the
 * publication's own address), and a stored template the instance's key no
 * longer opens answers its coded refusal, never another style.
 */
export async function GET(request: Request) {
  try {
    requireRequestAuth(request);
    const style = satelliteStyleDocument();
    if (!style) return noImageryResponse();
    return privateResponse(NextResponse.json(style));
  } catch (error) { return authFailure(error); }
}
