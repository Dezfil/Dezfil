import { withTrustedOperation } from "@/lib/trusted-operation";
import { NextResponse } from "next/server";
import { errorResponse, ApiError } from "@/lib/api/errors";
import { listDivisionCountries } from "@/lib/overture/divisions";
import {
  isValidRelease,
  latestOvertureRelease,
} from "@/lib/overture/releases";

/** Countries present in a release's divisions — the scope picker's roots
 * */
export async function GET(request: Request) {
  try {
    return await withTrustedOperation({ kind: "interactive-read", name: "Overture read", signal: request.signal }, async () => {
    const url = new URL(request.url);
    const release = url.searchParams.get("release") ?? "";
    if (release && !isValidRelease(release)) {
      throw new ApiError(
        "invalid_request",
        "The release must look like 2026-06-17.0.",
        400,
      );
    }
    const resolved = release || (await latestOvertureRelease());
    const countries = await listDivisionCountries(resolved);
    return NextResponse.json({ release: resolved, countries });
    });
  } catch (error) {
    return errorResponse(error);
  }
}
