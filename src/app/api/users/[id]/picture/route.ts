import { NextResponse } from "next/server";
import { requireRequestAdmin } from "@/lib/auth/admin-http";
import { authFailure, privateResponse } from "@/lib/auth/http";
import { removeUserPicture } from "@/lib/profile-pictures/admin";

/** An admin removes the account's picture; nobody sets another's. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = requireRequestAdmin(request), { id } = await params;
    return privateResponse(NextResponse.json({ account: await removeUserPicture(context, id) }));
  } catch (error) { return authFailure(error); }
}
