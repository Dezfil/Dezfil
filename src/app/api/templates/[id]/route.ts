import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api/errors";
import { authFailure, privateResponse, requireRequestAuth } from "@/lib/auth/http";
import { readTemplate } from "@/lib/templates/catalogue";
import { parseTemplateVersion } from "@/lib/templates/ids";

/** One template's card, how it is made and, once installed, what its
 * version holds: the version the query names, else the card's. Nothing is
 * sent. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireRequestAuth(request);
    const { id } = await params;
    const named = new URL(request.url).searchParams.get("version");
    const version = named === null ? null : parseTemplateVersion(named);
    if (named !== null && version === null) throw new ApiError("invalid_request", '"version" must be a whole number from 1.', 400);
    return privateResponse(NextResponse.json(await readTemplate(id, undefined, version)));
  } catch (error) { return authFailure(error); }
}
