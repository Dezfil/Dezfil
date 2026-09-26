import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { mapHistory } from "@/lib/map-service";

type Params = { params: Promise<{ id: string }> };

/** Whether the map currently has anything to undo or redo. */
export async function GET(_request: Request, { params }: Params) {
  try {
    const { id } = await params;
    return NextResponse.json(mapHistory(id));
  } catch (error) {
    return errorResponse(error);
  }
}
