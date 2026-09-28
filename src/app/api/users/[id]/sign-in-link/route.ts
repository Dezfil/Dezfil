import { NextResponse } from "next/server";
import { issueSignInLink } from "@/lib/auth/admin";
import { handOver, requireRequestAdmin } from "@/lib/auth/admin-http";
import { authFailure, privateResponse } from "@/lib/auth/http";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = requireRequestAdmin(request);
    const { id } = await params;
    return privateResponse(NextResponse.json(handOver(request, issueSignInLink(context, id))));
  } catch (error) { return authFailure(error); }
}
