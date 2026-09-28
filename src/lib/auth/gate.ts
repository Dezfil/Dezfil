import { NextResponse, type NextRequest } from "next/server";
import { accountCount } from "@/lib/metadata/accounts";
import { AuthError } from "./errors";
import { isAdminRequest, isEntryRequest, usesAccountGate } from "./request-policy";
import { requireAdmin } from "./admin";
import { metadataDb } from "@/lib/metadata/db";
import { assertRequestOrigin, authFailure, privateResponse, requestAuth, requestIngress, requireRequestAuth, sessionCookie, sessionSecret } from "./http";

/** An early refusal filter. Every protected handler authenticates again. */
export function gateRequest(request: NextRequest): Response {
  const pathname = request.nextUrl.pathname;
  if (!usesAccountGate(pathname)) return NextResponse.next();
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
    const response = privateResponse(NextResponse.next());
    if (context.credential.kind === "session" && pathname !== "/api/auth/sign-out") {
      sessionCookie(response, sessionSecret(request)!, ingress);
    }
    return response;
  } catch (error) {
    if (error instanceof AuthError && error.code === "authentication_required" && !pathname.startsWith("/api/")) {
      return privateResponse(NextResponse.redirect(new URL(accountCount() === 0 ? "/setup" : "/sign-in", requestIngress(request).origin)));
    }
    return authFailure(error);
  }
}
