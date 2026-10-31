import { externalSignIn } from "@/lib/auth/external-sign-in/config";
import { requirePasswordSignIn } from "@/lib/auth/external-sign-in/refusal";
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
    // The proxy already authenticates and renews sessions. In external mode,
    // reading the bounded patch first lets this handler refuse email edits
    // before its own authentication call or any profile update.
    const context = externalSignIn().enabled ? null : requireRequestAuth(request);
    const body = await authBody(request, ["name", "email", "currentPassword"], []);
    if (body.email !== undefined) requirePasswordSignIn();
    if ((body.name === undefined && body.email === undefined) || (body.name !== undefined && body.name.trim().length > 80)) {
      throw new AuthError("invalid_request", "Enter a name of at most 80 characters or an email address.", 400);
    }
    const account = await updateOwnProfile(context ?? requireRequestAuth(request), body, undefined, undefined, request.signal);
    return privateResponse(NextResponse.json({ account }));
  } catch (error) { return authFailure(error); }
}
