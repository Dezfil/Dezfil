import { NextResponse } from "next/server";
import { satelliteStyleDocument } from "@/lib/basemap-satellite";
import { authFailure, privateResponse, requireRequestAuth } from "@/lib/auth/http";

/**
 * The configured imagery style. Nothing ships with a satellite service
 * attached, so this answers only where an instance configured one; the
 * tile template stays server-side until it is composed into the style the
 * renderer loads. The style carries the whole template, so it answers a
 * signed-in request only, and a stored template the instance's key no
 * longer opens answers its coded refusal, never another style.
 */
export async function GET(request: Request) {
  try {
    requireRequestAuth(request);
    const style = satelliteStyleDocument();
    if (!style) return privateResponse(NextResponse.json(
      { error: "No satellite imagery is configured on this instance." },
      { status: 404 },
    ));
    return privateResponse(NextResponse.json(style));
  } catch (error) { return authFailure(error); }
}
