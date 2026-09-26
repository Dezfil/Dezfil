import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { changeGroupOf } from "@/lib/api/change-group";
import { duplicateLayer } from "@/lib/layer-service";

type Params = { params: Promise<{ id: string }> };

/** Duplicate a layer: full copy (SQL, style, tooltip, legend flag), suffixed
 * name, stacked on top of the map's layer order. */
export async function POST(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    return NextResponse.json(
      duplicateLayer(id, { groupId: changeGroupOf(request) }),
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
