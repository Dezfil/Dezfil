import { NextResponse } from "next/server";
import { changeAccountAccess } from "@/lib/auth/admin";
import { accessBody, requireRequestAdmin } from "@/lib/auth/admin-http";
import { authFailure, privateResponse } from "@/lib/auth/http";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = requireRequestAdmin(request);
    const { id } = await params, body = await accessBody(request);
    return privateResponse(NextResponse.json({ account: changeAccountAccess(context, id, body) }));
  } catch (error) { return authFailure(error); }
}
