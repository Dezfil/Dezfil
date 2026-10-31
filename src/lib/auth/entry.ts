import { externalSignIn } from "./external-sign-in/config";
import { requirePasswordSignIn } from "./external-sign-in/refusal";
import { readStoredSettings } from "@/lib/settings/store";
import { settingDefinition } from "@/lib/settings/catalogue";
import { NextResponse } from "next/server";
import { metadataDb } from "@/lib/metadata/db";
import { setupComplete } from "@/lib/metadata/accounts";
import { getSetting, instanceName } from "@/lib/metadata/settings";
import { createFirstAccount } from "./accounts";
import { signInFromRequest } from "./login-limits";
import { redeemSignInLink } from "./links";
import { signOut } from "./credentials";
import { PASSWORD_FLOOR } from "./passwords";
import { securitySettings } from "./security-settings";
import { assertRequestOrigin, authBody, authFailure, privateResponse, requestIngress, requireRequestAuth, sessionCookie, sessionSecret } from "./http";

export async function entryInformation(request: Request): Promise<Response> {
  try {
    requestIngress(request);
    const mode = externalSignIn();
    const db = metadataDb(), setupRequired = !mode.enabled && !setupComplete(db);
    const stored = readStoredSettings(db);
    return privateResponse(NextResponse.json({ instanceName: instanceName(db),
      externalSignIn: { enabled: mode.enabled, doorUrl: mode.enabled ? mode.doorUrl : null },
      signInMessage: stored.signInMessage ?? settingDefinition("signInMessage").defaultValue,
      lostPasswordContact: stored.lostPasswordContact ?? settingDefinition("lostPasswordContact").defaultValue,
      landingPage: stored.landingPage ?? settingDefinition("landingPage").defaultValue,
      // What a password chosen on these screens needs: the first account takes the floor.
      passwordMin: setupRequired ? PASSWORD_FLOOR : securitySettings(db).passwordMin, setupRequired,
      ...(setupRequired ? { prefillName: getSetting("display_name", db) ?? "" } : {}) }));
  } catch (error) { return authFailure(error); }
}
export async function enter(request: Request, action: "setup" | "sign-in" | "redeem"): Promise<Response> {
  try {
    requirePasswordSignIn();
    const ingress = requestIngress(request);
    assertRequestOrigin(request);
    const fields = action === "setup" ? ["name", "email", "password"] : action === "sign-in" ? ["email", "password"] : ["secret", "password"];
    const body = await authBody(request, fields);
    const result = action === "setup" ? await createFirstAccount({ name: body.name, email: body.email, password: body.password }, undefined, undefined, request.signal)
      : action === "sign-in" ? await signInFromRequest(request, body.email, body.password)
        : await redeemSignInLink(body.secret, body.password, undefined, undefined, request.signal);
    const response = privateResponse(NextResponse.json({ account: result.account }));
    sessionCookie(response, result.secret, ingress);
    return response;
  } catch (error) { return authFailure(error); }
}
export async function currentSession(request: Request): Promise<Response> {
  try {
    const context = requireRequestAuth(request);
    const response = privateResponse(NextResponse.json({ account: context.account }));
    if (context.credential.kind === "session") sessionCookie(response, sessionSecret(request)!, requestIngress(request));
    return response;
  } catch (error) { return authFailure(error); }
}
export async function leave(request: Request): Promise<Response> {
  try {
    const context = requireRequestAuth(request);
    assertRequestOrigin(request, context);
    signOut(context);
    const response = privateResponse(NextResponse.json({ signedOut: true }));
    sessionCookie(response, "", requestIngress(request), true);
    return response;
  } catch (error) { return authFailure(error); }
}
