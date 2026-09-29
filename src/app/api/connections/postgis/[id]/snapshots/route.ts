import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { connectionSnapshots } from "@/lib/postgis/connection-service";

type Params = { params: Promise<{ id: string }> };
export async function GET(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    return NextResponse.json(await connectionSnapshots(scope, (await params).id));
  } catch (error) { return errorResponse(error); }
}
