import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api/errors";
import { smallJsonValue } from "@/lib/api/json-body";
import { requireRequestAdmin } from "@/lib/auth/admin-http";
import { authFailure, privateResponse } from "@/lib/auth/http";
import { removeLibraryStyle, setLibraryStyleOffered } from "@/lib/basemap-library";

type Params = { params: Promise<{ id: string }> };

/** Offer or hide an added style where a basemap is chosen. */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const context = requireRequestAdmin(request);
    const input = await smallJsonValue(request, () => null);
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
      throw new ApiError("invalid_request", "Expected a JSON body.", 400);
    }
    return privateResponse(NextResponse.json(setLibraryStyleOffered(context, (await params).id, input)));
  } catch (error) { return authFailure(error); }
}

/** Remove an added style from the library. Maps that took it keep their copy. */
export async function DELETE(request: Request, { params }: Params) {
  try {
    const context = requireRequestAdmin(request);
    return privateResponse(NextResponse.json(removeLibraryStyle(context, (await params).id)));
  } catch (error) { return authFailure(error); }
}
