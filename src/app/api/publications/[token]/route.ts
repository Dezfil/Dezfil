import { requireRequestAdmin } from "@/lib/auth/admin-http";
import { authFailure, privateResponse } from "@/lib/auth/http";
import { revokeInactivePublication } from "@/lib/publish/admin-revocation";

export async function DELETE(request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const actor = requireRequestAdmin(request);
    const { token } = await params;
    revokeInactivePublication(actor, token);
    return privateResponse(new Response(null, { status: 204 }));
  } catch (error) { return privateResponse(authFailure(error)); }
}
