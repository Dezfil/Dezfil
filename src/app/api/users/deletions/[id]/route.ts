import { NextResponse } from "next/server";
import { requireRequestAdmin } from "@/lib/auth/admin-http";
import { accountDeletionStatus } from "@/lib/auth/account-deletion-status";
import { authFailure, privateResponse } from "@/lib/auth/http";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = requireRequestAdmin(request), { id } = await params;
    return privateResponse(NextResponse.json(accountDeletionStatus(context, id)));
  } catch (error) { return authFailure(error); }
}
