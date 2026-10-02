import { apiMethodResponse } from "./api-methods";
import { isAnonymousAsset } from "./public-assets";
import { NextResponse, type NextRequest } from "next/server";
import { accountCount } from "@/lib/metadata/accounts";
import { AuthError } from "./errors";
import { isAdminRequest, isAnonymousOperation, isEntryRequest } from "./request-policy";
import { requireAdmin } from "./admin";
import { metadataDb } from "@/lib/metadata/db";
import { assertRequestOrigin, authFailure, privateResponse, requestAuth, requestIngress, requireRequestAuth, sessionCookie, sessionSecret } from "./http";

/** Early refusal only. Handlers needing identity reauthenticate the credential. */
export function gateRequest(request: NextRequest): Response {
  const pathname = request.nextUrl.pathname;
  if (isAnonymousAsset(pathname, request.method, process.env.NODE_ENV === "development") ||
      (isAnonymousOperation(pathname, request.method) && !isEntryRequest(pathname, request.method))) return NextResponse.next();
  try {
    const ingress = requestIngress(request);
    const redirect = (destination: string) => privateResponse(NextResponse.redirect(new URL(destination, ingress.origin)));
    if (isEntryRequest(pathname, request.method)) {
      assertRequestOrigin(request);
      if (pathname === "/setup" || pathname === "/sign-in") {
        const setupRequired = accountCount() === 0;
        if (setupRequired && pathname !== "/setup") return redirect("/setup");
        if (!setupRequired) {
          const context = requestAuth(request);
          if (context) return redirect("/");
          if (pathname === "/setup") return redirect("/sign-in");
        }
      }
      return privateResponse(NextResponse.next());
    }
    const context = requireRequestAuth(request);
    if (isAdminRequest(pathname)) requireAdmin(context, metadataDb(), Date.now());
    const response = privateResponse(apiMethodResponse(pathname, request.method) ?? NextResponse.next());
    if (!request.headers.has("authorization") && context.credential.kind === "session" && pathname !== "/api/auth/sign-out") {
      sessionCookie(response, sessionSecret(request)!, ingress);
    }
    return response;
  } catch (error) {
    if (error instanceof AuthError && error.code === "authentication_required" && pathname !== "/api" && !pathname.startsWith("/api/")) {
      return privateResponse(NextResponse.redirect(new URL(accountCount() === 0 ? "/setup" : "/sign-in", requestIngress(request).origin)));
    }
    return authFailure(error);
  }
}
