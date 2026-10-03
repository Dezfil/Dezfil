import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { readMapDependencies } from "@/lib/map-dependencies";

type Params = { params: Promise<{ id: string }> };

/** The datasets a map draws from: the 14-A checklist's
 * documented read. */
export async function GET(_request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(_request);
    const { id } = await params;
    return NextResponse.json(await readMapDependencies(scope, id));
  } catch (error) {
    return errorResponse(error);
  }
}
