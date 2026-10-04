import { NextResponse } from "next/server";
import { adminAccounts, inviteAccount } from "@/lib/auth/admin";
import { handOver, invitationBody, requireRequestAdmin } from "@/lib/auth/admin-http";
import { authFailure, privateResponse } from "@/lib/auth/http";
import { listAccountDeletions } from "@/lib/auth/account-deletion-status";

export async function GET(request: Request) {
  try {
    const context = requireRequestAdmin(request);
    return privateResponse(NextResponse.json({ users: adminAccounts(context), deletions: listAccountDeletions(context) }));
  } catch (error) { return authFailure(error); }
}

export async function POST(request: Request) {
  try {
    const context = requireRequestAdmin(request);
    const body = await invitationBody(request);
    return privateResponse(NextResponse.json(handOver(request, inviteAccount(context, body)), { status: 201 }));
  } catch (error) { return authFailure(error); }
}
