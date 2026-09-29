import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { editConnection, removeConnection } from "@/lib/postgis/connection-service";

type Params = { params: Promise<{ id: string }> };
export async function PATCH(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    const { id } = await params;
    return NextResponse.json(await editConnection(scope, id, await request.json().catch(() => null)));
  } catch (error) { return errorResponse(error); }
}
/** Imported snapshots retain their owner and data after connection deletion. */
export async function DELETE(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    removeConnection(scope, (await params).id);
    return new NextResponse(null, { status: 204 });
  } catch (error) { return errorResponse(error); }
}
