import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { listProjections } from "@/lib/geometry/projections";
import { geometryQuery } from "@/lib/geometry/request";

export async function GET(request: Request) {
  try {
    const epsg = geometryQuery(request, ["epsg"]).get("epsg");
    return NextResponse.json(await listProjections(epsg ?? undefined));
  } catch (error) { return errorResponse(error); }
}
