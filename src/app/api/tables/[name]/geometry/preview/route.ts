import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { previewGeometry } from "@/lib/geometry/service";
import { geometryQuery, geometryRequest } from "@/lib/geometry/request";
import { requireOwnDataset } from "@/lib/dataset-address";

type Params = { params: Promise<{ name: string }> };
export async function POST(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    geometryQuery(request, []);
    // A preview of a geometry change: the owner's, like the change itself.
    const name = requireOwnDataset(scope, (await params).name).table.name;
    const { expectedRevision, choice } = await geometryRequest(request);
    return NextResponse.json(await previewGeometry(scope, name, expectedRevision, choice));
  } catch (error) { return errorResponse(error); }
}
