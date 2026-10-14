import { NextResponse } from "next/server";
import { authFailure, privateResponse, requireRequestAuth } from "@/lib/auth/http";
import { listProjections } from "@/lib/geometry/projections";
import { geometryQuery } from "@/lib/geometry/request";

export async function GET(request: Request) {
  try {
    requireRequestAuth(request);
    const epsg = geometryQuery(request, ["epsg"]).get("epsg");
    return privateResponse(NextResponse.json(await listProjections(epsg ?? undefined, request.signal)));
  } catch (error) { return authFailure(error); }
}
