import { NextResponse } from "next/server";
import { errorResponse, ApiError } from "@/lib/api/errors";
import { countryDivisionIndex } from "@/lib/overture/divisions";
import {
  isValidRelease,
  latestOvertureRelease,
} from "@/lib/overture/releases";

/** A country's states/regions with their ISO codes — the state scope
 * picker. Empty when the country has no region level. */
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
    const states = index
      .filter((r) => r.subtype === "region" && r.region)
      .map((r) => ({ code: r.region as string, name: r.name, bbox: r.bbox }))
      .sort((a, b) => a.name.localeCompare(b.name, "en"));
    return NextResponse.json({ release: resolved, states });
  } catch (error) {
    return errorResponse(error);
  }
}
