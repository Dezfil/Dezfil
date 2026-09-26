import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { inspectGeometry, setGeometry, clearGeometry } from "@/lib/geometry/service";
import { geometryQuery, geometryRequest, requiredGeometryRevision } from "@/lib/geometry/request";

type Params = { params: Promise<{ name: string }> };
export async function GET(request: Request, { params }: Params) {
  try {
    geometryQuery(request, []);
    return NextResponse.json(await inspectGeometry((await params).name));
  } catch (error) { return errorResponse(error); }
}
export async function PUT(request: Request, { params }: Params) {
  try {
    geometryQuery(request, []);
    const { expectedRevision, choice } = await geometryRequest(request);
    return NextResponse.json(await setGeometry((await params).name, expectedRevision, choice));
  } catch (error) { return errorResponse(error); }
}
export async function DELETE(request: Request, { params }: Params) {
  try {
    const revision = requiredGeometryRevision(geometryQuery(request, ["expectedRevision"]).get("expectedRevision"));
    return NextResponse.json(await clearGeometry((await params).name, revision));
  } catch (error) { return errorResponse(error); }
}
