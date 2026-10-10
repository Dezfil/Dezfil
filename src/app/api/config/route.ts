import { NextResponse } from "next/server";
import {
  basemapOverrideUrl,
  basemapUrl,
  offeredBasemaps,
} from "@/lib/basemap-offer";
import { offeredLibraryStyles } from "@/lib/basemap-library";
import { PALETTES } from "@/lib/style/palettes";
import { limits } from "@/lib/limits";
import { geocoderConfigured } from "@/lib/search/provider";
import { instanceDefaults, reportedDefaults } from "@/lib/settings/defaults";
import { authFailure, privateResponse, requireRequestAuth } from "@/lib/auth/http";
import { securitySettings } from "@/lib/auth/security-settings";

/** Runtime client configuration (basemaps, palettes, limits worth showing in
 * the UI, what new things start with, the rules every account follows and
 * the shortest password). */
export async function GET(request: Request) {
  try {
    requireRequestAuth(request);
    const security = securitySettings();
    return privateResponse(NextResponse.json({
      basemapUrl: basemapUrl(),
      basemapOverrideUrl: basemapOverrideUrl(),
      // The styles a person may choose: those an admin hid are left out.
      basemaps: offeredBasemaps(),
      // The styles an admin added to the library and offers: a map that
      // takes one keeps its own copy.
      basemapStyles: offeredLibraryStyles(),
      palettes: PALETTES,
      renderCapFeatures: limits.renderCapFeatures,
      previewRows: limits.previewRows,
      // Configured-or-not only: the URL itself — which may carry a key —
      // never reaches the browser.
      geocoderConfigured: geocoderConfigured(),
      defaults: reportedDefaults(instanceDefaults()),
      // The rules every account follows, keyed and valued as the change operation takes them.
      rules: security.rules,
      passwordMin: security.passwordMin,
    }));
  } catch (error) { return authFailure(error); }
}
