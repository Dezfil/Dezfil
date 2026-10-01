import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { requireRequestScope } from "@/lib/auth/scope-http";
import { listProjectPeople } from "@/lib/metadata/project-people";

type Params = { params: Promise<{ id: string }> };

/** A reached project's people: its owner first, then its members. */
export async function GET(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    const { id } = await params;
    return NextResponse.json({ people: listProjectPeople(scope, id) });
  } catch (error) {
    return errorResponse(error);
  }
}
