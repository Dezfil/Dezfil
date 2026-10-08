import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api/errors";
import { requireRequestAdmin } from "@/lib/auth/admin-http";
import { authFailure, privateResponse } from "@/lib/auth/http";
import { isTestedService } from "@/lib/settings/service-test-answer";
import { testService } from "@/lib/settings/service-tests";

/** Send one service its Test, at the address in effect. */
export async function POST(request: Request, { params }: { params: Promise<{ service: string }> }) {
  try {
    const context = requireRequestAdmin(request);
    const { service } = await params;
    if (!isTestedService(service)) {
      throw new ApiError("not_found", "There is no such service to test: geocode, isochrone, overpass, overture or s3.", 404);
    }
    return privateResponse(NextResponse.json(await testService(context, service)));
  } catch (error) { return authFailure(error); }
}
