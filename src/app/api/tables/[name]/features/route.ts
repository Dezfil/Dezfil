import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { tableFeatures } from "@/lib/table-service";

type Params = { params: Promise<{ name: string }> };

/**
 * A table's features as GeoJSON for the import dialog's map: the layer
 * legend draws them and Select from Layer picks one as a query area. A
 * table that cannot draw — no geometry, over the render cap — returns
 * ok:false with a reason, not an HTTP error.
 */
export async function GET(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    const { name } = await params;
    // ?sample=1: over-cap tables draw a capped subset instead of refusing
    // — the dataset detail's map preview opts in.
    const sample = new URL(request.url).searchParams.get("sample") === "1";
    return NextResponse.json(await tableFeatures(scope, name, { sample }));
  } catch (error) {
    return errorResponse(error);
  }
}
