import { withStorageRecovery } from "@/lib/system/storage-reserve";
import { NextResponse } from "next/server";
import { requireRequestAdmin } from "@/lib/auth/admin-http";
import { authFailure, privateResponse } from "@/lib/auth/http";
import { ApiError } from "@/lib/api/errors";
import { clearServiceCaches, isProviderCache } from "@/lib/settings/service-facts";

/** Clear one provider cache, named by `service`, or all three. */
export async function DELETE(request: Request) {
  try {
    const context = requireRequestAdmin(request);
    const params = new URL(request.url).searchParams;
    const named = params.getAll("service");
    const service = named[0] ?? null;
    if (named.length > 1 || [...params.keys()].some(key => key !== "service") || (service !== null && !isProviderCache(service))) {
      throw new ApiError("invalid_request", "Name one cache to clear (geocode, isochrone or overpass), or none to clear all three.", 400);
    }
    return privateResponse(NextResponse.json(await withStorageRecovery(() => clearServiceCaches(context, service))));
  } catch (error) { return authFailure(error); }
}
