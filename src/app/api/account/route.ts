import { NextResponse } from "next/server";
import { updateOwnProfile } from "@/lib/auth/accounts";
import { requireCurrentActor } from "@/lib/auth/credentials";
import { AuthError } from "@/lib/auth/errors";
import { authBody, authFailure, privateResponse, requireRequestAuth } from "@/lib/auth/http";

export async function GET(request: Request) {
  try {
    return privateResponse(NextResponse.json({ account: requireCurrentActor(requireRequestAuth(request)) }));
  } catch (error) { return authFailure(error); }
}

export async function PATCH(request: Request) {
  try {
    const context = requireRequestAuth(request);
    const body = await authBody(request, ["name", "email", "currentPassword"], []);
    if ((body.name === undefined && body.email === undefined) || (body.name !== undefined && body.name.trim().length > 80)) {
      throw new AuthError("invalid_request", "Enter a name of at most 80 characters or an email address.", 400);
    }
    const account = await updateOwnProfile(context, body);
    return privateResponse(NextResponse.json({ account }));
  } catch (error) { return authFailure(error); }
}
