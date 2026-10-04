import { requireRequestAdmin } from "@/lib/auth/admin-http";
import { advanceDeletionResponse } from "@/lib/auth/account-deletion-http";
import { authFailure } from "@/lib/auth/http";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = requireRequestAdmin(request), { id } = await params;
    return await advanceDeletionResponse(context, id);
  } catch (error) { return authFailure(error); }
}
