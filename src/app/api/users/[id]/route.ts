import { NextResponse } from "next/server";
import { changeAccountAccess } from "@/lib/auth/admin";
import { accessBody, deletionBody, requireRequestAdmin } from "@/lib/auth/admin-http";
import { authFailure, privateResponse } from "@/lib/auth/http";
import { confirmAccountDeletion } from "@/lib/auth/account-deletion-preview";
import { deletionEligibility } from "@/lib/auth/account-deletion-eligibility";
import { advanceDeletionResponse, deletionResponse } from "@/lib/auth/account-deletion-http";
import { metadataDb } from "@/lib/metadata/db";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = requireRequestAdmin(request);
    const { id } = await params, body = await accessBody(request);
    return privateResponse(NextResponse.json({ account: changeAccountAccess(context, id, body) }));
  } catch (error) { return authFailure(error); }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = requireRequestAdmin(request), { id } = await params;
    const { pending } = deletionEligibility(context, id, metadataDb());
    const accepted = confirmAccountDeletion(context, id, await deletionBody(request));
    return pending ? deletionResponse(accepted) : await advanceDeletionResponse(context, accepted.id);
  } catch (error) { return authFailure(error); }
}
