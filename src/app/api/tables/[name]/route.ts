import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { inspectTable, removeTable } from "@/lib/table-service";

type Params = { params: Promise<{ name: string }> };

/** Inspect one table: registry entry, schema, and a row preview. */
export async function GET(_request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(_request);
    const { name } = await params;
    return NextResponse.json(await inspectTable(scope, name, _request.signal));
  } catch (error) {
    return errorResponse(error);
  }
}

/** Delete a table and its data artifact. */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(_request);
    const { name } = await params;
    await removeTable(scope, name);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
