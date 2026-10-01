import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { inspectGeometry, setGeometry, clearGeometry } from "@/lib/geometry/service";
import { geometryQuery, geometryRequest, requiredGeometryRevision } from "@/lib/geometry/request";
import { requireOwnDataset } from "@/lib/dataset-address";

/** Geometry is changed only by the dataset's owner, and its inspection serves
 * that change: another person's dataset is refused by the permission shape,
 * whichever address names it. */
const ownName = async (scope: Parameters<typeof requireOwnDataset>[0], params: Params["params"]) =>
  requireOwnDataset(scope, (await params).name).table.name;

type Params = { params: Promise<{ name: string }> };
export async function GET(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    geometryQuery(request, []);
    return NextResponse.json(await inspectGeometry(scope, await ownName(scope, params)));
  } catch (error) { return errorResponse(error); }
}
export async function PUT(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    geometryQuery(request, []);
    const name = await ownName(scope, params);
    const { expectedRevision, choice } = await geometryRequest(request);
    return NextResponse.json(await setGeometry(scope, name, expectedRevision, choice));
  } catch (error) { return errorResponse(error); }
}
export async function DELETE(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    const name = await ownName(scope, params);
    const revision = requiredGeometryRevision(geometryQuery(request, ["expectedRevision"]).get("expectedRevision"));
    return NextResponse.json(await clearGeometry(scope, name, revision));
  } catch (error) { return errorResponse(error); }
}
