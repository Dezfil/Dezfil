import { withStorageRecovery } from "@/lib/system/storage-reserve";
import { NextResponse } from "next/server";
import { revokeApiToken } from "@/lib/auth/credentials";
import { authFailure, privateResponse, requireRequestAuth } from "@/lib/auth/http";

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = requireRequestAuth(request);
    const { id } = await params;
    await withStorageRecovery(() => revokeApiToken(context, id));
    return privateResponse(NextResponse.json({ revoked: true }));
  } catch (error) { return authFailure(error); }
}
