import { largeJsonValue } from "@/lib/api/json-body";
import { NextResponse } from "next/server";
import { authFailure, privateResponse, requireRequestAuth } from "@/lib/auth/http";
import { patchOwnSettings, readOwnSettings } from "@/lib/auth/settings";

export async function GET(request: Request) {
  try {
    return privateResponse(NextResponse.json(readOwnSettings(requireRequestAuth(request))));
  } catch (error) { return authFailure(error); }
}

export async function PATCH(request: Request) {
  try {
    const context = requireRequestAuth(request);
    const body: unknown = await largeJsonValue(request, () => null);
    return privateResponse(NextResponse.json(patchOwnSettings(context, body)));
  } catch (error) { return authFailure(error); }
}
