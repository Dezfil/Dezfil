import { NextResponse } from "next/server";
import { requireRequestAdmin } from "@/lib/auth/admin-http";
import { previewAccountDeletion } from "@/lib/auth/account-deletion-preview";
import { authFailure, privateResponse } from "@/lib/auth/http";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = requireRequestAdmin(request), { id } = await params;
    return privateResponse(NextResponse.json(previewAccountDeletion(context, id)));
  } catch (error) { return authFailure(error); }
}
