import { NextResponse } from "next/server";
import { authFailure, privateResponse } from "@/lib/auth/http";
import { findAccounts } from "@/lib/auth/directory";
import { requireRequestScope } from "@/lib/auth/scope-http";

/** Find active people to share with, by display name or exact email. */
export async function GET(request: Request) {
  try {
    const scope = requireRequestScope(request);
    const query = new URL(request.url).searchParams.get("q");
    return privateResponse(NextResponse.json({ accounts: findAccounts(scope, query) }));
  } catch (error) {
    return authFailure(error);
  }
}
