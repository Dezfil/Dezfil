import { apiMethodResponse } from "./api-methods";
import { isAnonymousAsset } from "./public-assets";
import { NextResponse } from "next/server";
import { setupComplete } from "@/lib/metadata/accounts";
import { AuthError } from "./errors";
import { isAdminRequest, isAnonymousOperation, isEntryRequest, isPublishedPage } from "./request-policy";
import { publishedFramingPolicy } from "./published-framing";
import { requireAdmin } from "./admin";
import { metadataDb } from "@/lib/metadata/db";
import { assertRequestOrigin, authFailure, privateResponse, requestAuth, requestIngress, requireRequestAuth, sessionCookie, sessionSecret } from "./http";

/** Early refusal only. Handlers needing identity reauthenticate the credential. */
export function gateRequest(request: Request): Response {
  const pathname = new URL(request.url).pathname;
  if (isAnonymousAsset(pathname, request.method, process.env.NODE_ENV === "development") ||
      (isAnonymousOperation(pathname, request.method) && !isEntryRequest(pathname, request.method))) {
    const response = NextResponse.next();
    // A published page says which other sites may frame it, read afresh
    // for each answer; the published API responses carry no such policy.
    if (isPublishedPage(pathname)) {
      const policy = publishedFramingPolicy();
      if (policy) response.headers.set("Content-Security-Policy", policy);
    }
    return response;
  }
  try {
    const ingress = requestIngress(request);
    const redirect = (destination: string) => privateResponse(NextResponse.redirect(new URL(destination, ingress.origin)));
    if (isEntryRequest(pathname, request.method)) {
      assertRequestOrigin(request);
      if (pathname === "/setup" || pathname === "/sign-in") {
        const setupRequired = !setupComplete();
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
      return privateResponse(NextResponse.redirect(new URL(!setupComplete() ? "/setup" : "/sign-in", requestIngress(request).origin)));
    }
    return authFailure(error);
  }
}
