import { largeJsonValue } from "@/lib/api/json-body";
import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { listConnections } from "@/lib/metadata/connections";
import { createConnection } from "@/lib/postgis/connection-service";

/** List the account's saved connections without passwords. */
export async function GET(request: Request) {
  try {
    return NextResponse.json(listConnections(requireRequestScope(request)));
  } catch (error) { return errorResponse(error); }
}
/** Test first, then save for the authenticated creator. */
export async function POST(request: Request) {
  try {
    const scope = requireRequestScope(request);
    return NextResponse.json(await createConnection(scope, await largeJsonValue(request, () => null), request.signal), { status: 201 });
  } catch (error) { return errorResponse(error); }
}
