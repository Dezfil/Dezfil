import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { undoChange } from "@/lib/map-service";

type Params = { params: Promise<{ id: string }> };

/** Revert the map's newest recorded change — or the whole grouped turn.
 * Returns the refreshed map with fresh history availability. */
export async function POST(_request: Request, { params }: Params) {
  try {
    const { id } = await params;
    return NextResponse.json(await undoChange(id));
  } catch (error) {
    return errorResponse(error);
  }
}
