import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { requireRequestScope } from "@/lib/auth/scope-http";
import { readTableReaders } from "@/lib/table-readers";

type Params = { params: Promise<{ name: string }> };

/** What reads one of the caller's own tables, asked before deleting it.
 * The request's departure stops the scan. */
export async function GET(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    const { name } = await params;
    return NextResponse.json(await readTableReaders(scope, name, request.signal));
  } catch (error) {
    return errorResponse(error);
  }
}
