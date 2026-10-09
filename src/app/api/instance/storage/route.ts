import { NextResponse } from "next/server";
import { requireRequestAdmin } from "@/lib/auth/admin-http";
import { assertRequestOrigin, authFailure, privateResponse } from "@/lib/auth/http";
import { readStorage } from "@/lib/system/storage";

/** What the data folder holds, by kind. Admins only. */
export async function GET(request: Request) {
  try {
    const context = requireRequestAdmin(request);
    // The walk is work this server does when asked: a cookie must show it
    // comes from this instance's own page, as a change's must.
    assertRequestOrigin(request, context, "protected_read");
    return privateResponse(NextResponse.json(await readStorage(context)));
  } catch (error) { return authFailure(error); }
}
