import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api/errors";
import { smallJsonValue } from "@/lib/api/json-body";
import { requireRequestAdmin } from "@/lib/auth/admin-http";
import { authFailure, privateResponse } from "@/lib/auth/http";
import { addLibraryStyle } from "@/lib/basemap-library";

/** Add a style to the basemap library by its address, read once now. */
export async function POST(request: Request) {
  try {
    const context = requireRequestAdmin(request);
    const input = await smallJsonValue(request, () => null);
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
      throw new ApiError("invalid_request", "Expected a JSON body.", 400);
    }
    return privateResponse(NextResponse.json(await addLibraryStyle(context, input), { status: 201 }));
  } catch (error) { return authFailure(error); }
}
