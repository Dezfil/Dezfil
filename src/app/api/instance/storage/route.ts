import { NextResponse } from "next/server";
import { requireRequestAdmin } from "@/lib/auth/admin-http";
import { AuthError } from "@/lib/auth/errors";
import { authFailure, privateResponse, requestIngress } from "@/lib/auth/http";
import { readStorage } from "@/lib/system/storage";

/** What the data folder holds, by kind. Admins only. */
export async function GET(request: Request) {
  try {
    const context = requireRequestAdmin(request);
    // The walk is work this server does when asked, so a cookie a page of
    // another origin sends is refused it, as a change would be. A token
    // calls directly, and this instance's own pages send no other origin.
    const origin = request.headers.get("origin");
    if (context.credential.kind !== "token" && context.delegationExpiresAt === undefined &&
        origin !== null && origin !== requestIngress(request).origin) {
      throw new AuthError("forbidden", "This request must come from the same instance.", 403);
    }
    return privateResponse(NextResponse.json(await readStorage(context)));
  } catch (error) { return authFailure(error); }
}
