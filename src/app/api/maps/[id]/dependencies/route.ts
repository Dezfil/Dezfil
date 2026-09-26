import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { mapDependencies } from "@/lib/map-dependencies";

type Params = { params: Promise<{ id: string }> };

/** The datasets a map draws from: the 14-A checklist's
 * documented read. */
export async function GET(_request: Request, { params }: Params) {
  try {
    const { id } = await params;
    return NextResponse.json({ datasets: await mapDependencies(id) });
  } catch (error) {
    return errorResponse(error);
  }
}
