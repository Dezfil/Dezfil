import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { browseConnection } from "@/lib/postgis/connection-service";

type Params = { params: Promise<{ id: string }> };
export async function GET(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    return NextResponse.json(await browseConnection(scope, (await params).id, request.signal));
  } catch (error) { return errorResponse(error); }
}
