import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { redoChange } from "@/lib/map-service";
import { mapPresence } from "@/lib/reach-presence";

type Params = { params: Promise<{ id: string }> };

/** Re-apply the map's newest undone change — or the whole grouped turn.
 * Returns the refreshed map with fresh history availability. */
export async function POST(_request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(_request);
    const { id } = await params;
    return NextResponse.json({ ...(await redoChange(scope, id, { expectedRevision: _request.headers.get("X-Edit-Revision") })), ...mapPresence(scope, id) });
  } catch (error) {
    return errorResponse(error);
  }
}
