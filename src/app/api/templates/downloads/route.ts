import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api/errors";
import { requireRequestAdmin } from "@/lib/auth/admin-http";
import { authFailure, privateResponse } from "@/lib/auth/http";
import { removeTemplateDownloads } from "@/lib/templates/remove";

/** Remove every downloaded template: an admin's call. */
export async function DELETE(request: Request) {
  try {
    const context = requireRequestAdmin(request);
    if ([...new URL(request.url).searchParams.keys()].length > 0) {
      throw new ApiError("invalid_request", "Remove all takes no parameters: it removes every downloaded template.", 400);
    }
    return privateResponse(NextResponse.json(await removeTemplateDownloads(context)));
  } catch (error) { return authFailure(error); }
}
