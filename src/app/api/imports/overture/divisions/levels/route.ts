import { NextResponse } from "next/server";
import { errorResponse, ApiError } from "@/lib/api/errors";
import {
  aggregateLevels,
  countryDivisionIndex,
} from "@/lib/overture/divisions";
import {
  isValidRelease,
  latestOvertureRelease,
} from "@/lib/overture/releases";

/** Admin levels that actually exist in a country, with counts and sample
 * names — the evidence-bearing level picker. */
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
    return NextResponse.json({
      release: resolved,
      country: country.toUpperCase(),
      levels: aggregateLevels(index),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
