import { NextResponse } from "next/server";
import {
  availableBasemaps,
  basemapOverrideUrl,
  basemapUrl,
} from "@/lib/basemap";
import { PALETTES } from "@/lib/style/palettes";
import { limits } from "@/lib/limits";
import { geocoderConfigured } from "@/lib/search/provider";
import { authFailure, privateResponse, requireRequestAuth } from "@/lib/auth/http";

/** Runtime client configuration (basemaps, palettes, limits worth showing in the UI). */
export async function GET(request: Request) {
  try {
    requireRequestAuth(request);
    return privateResponse(NextResponse.json({
      basemapUrl: basemapUrl(),
      basemapOverrideUrl: basemapOverrideUrl(),
      basemaps: availableBasemaps(),
      palettes: PALETTES,
      renderCapFeatures: limits.renderCapFeatures,
      previewRows: limits.previewRows,
      // Configured-or-not only: the URL itself — which may carry a key —
      // never reaches the browser.
      geocoderConfigured: geocoderConfigured(),
    }));
  } catch (error) { return authFailure(error); }
}
