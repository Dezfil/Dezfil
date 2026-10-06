import { NextResponse } from "next/server";
import { requireRequestAdmin } from "@/lib/auth/admin-http";
import { authFailure, privateResponse } from "@/lib/auth/http";
import { readInstanceSettings } from "@/lib/settings/read";
import { changeInstanceSettings } from "@/lib/settings/change";
import { smallJsonValue } from "@/lib/api/json-body";
import { ApiError } from "@/lib/api/errors";

export async function GET(request: Request) {
  try {
    const context = requireRequestAdmin(request);
    return privateResponse(NextResponse.json(readInstanceSettings(context)));
  } catch (error) { return authFailure(error); }
}

export async function PATCH(request: Request) {
  try {
    const context = requireRequestAdmin(request);
    const input = await smallJsonValue(request, () => null);
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
      throw new ApiError("invalid_request", "Expected a JSON body.", 400);
    }
    return privateResponse(NextResponse.json(changeInstanceSettings(context, input)));
  } catch (error) { return authFailure(error); }
}
