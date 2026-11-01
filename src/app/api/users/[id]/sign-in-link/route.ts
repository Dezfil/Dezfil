import { requirePasswordSignIn } from "@/lib/auth/external-sign-in/refusal";
import { withStorageRecovery } from "@/lib/system/storage-reserve";
import { NextResponse } from "next/server";
import { issueSignInLink } from "@/lib/auth/admin";
import { handOver, requireRequestAdmin } from "@/lib/auth/admin-http";
import { authFailure, privateResponse } from "@/lib/auth/http";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requirePasswordSignIn();
    const context = requireRequestAdmin(request);
    const { id } = await params;
    const link = await withStorageRecovery(() => issueSignInLink(context, id));
    return privateResponse(NextResponse.json(handOver(request, link)));
  } catch (error) { return authFailure(error); }
}
