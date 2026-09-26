import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { previewGeometry } from "@/lib/geometry/service";
import { geometryQuery, geometryRequest } from "@/lib/geometry/request";

type Params = { params: Promise<{ name: string }> };
export async function POST(request: Request, { params }: Params) {
  try {
    geometryQuery(request, []);
    const { expectedRevision, choice } = await geometryRequest(request);
    return NextResponse.json(await previewGeometry((await params).name, expectedRevision, choice));
  } catch (error) { return errorResponse(error); }
}
