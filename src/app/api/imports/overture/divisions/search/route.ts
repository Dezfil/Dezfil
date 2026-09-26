import { NextResponse } from "next/server";
import { errorResponse, ApiError } from "@/lib/api/errors";
import {
  countryDivisionIndex,
  searchIndex,
} from "@/lib/overture/divisions";
import {
  isValidRelease,
  latestOvertureRelease,
} from "@/lib/overture/releases";

/** Find a city or municipality by name within a country — the typed city
 * scope; names come from the division data itself, never a geocoder. */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const country = url.searchParams.get("country") ?? "";
    if (!/^[A-Za-z]{2}$/.test(country)) {
      throw new ApiError(
        "invalid_request",
        "Provide country as a two-letter ISO code (e.g. DE).",
        400,
      );
    }
    const q = url.searchParams.get("q") ?? "";
    if (!q.trim()) {
      throw new ApiError("invalid_request", "Provide a search text as q.", 400);
    }
    const release = url.searchParams.get("release") ?? "";
    if (release && !isValidRelease(release)) {
      throw new ApiError(
        "invalid_request",
        "The release must look like 2026-06-17.0.",
        400,
      );
    }
    const resolved = release || (await latestOvertureRelease());
    const index = await countryDivisionIndex(resolved, country);
    const matches = searchIndex(index, q).map((m) => ({
      id: m.divisionId,
      name: m.name,
      subtype: m.subtype,
      kind: m.label,
      region: m.region,
      bbox: m.bbox,
    }));
    return NextResponse.json({ release: resolved, matches });
  } catch (error) {
    return errorResponse(error);
  }
}
