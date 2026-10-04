import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { requireRequestScope } from "@/lib/auth/scope-http";
import { leaveProject } from "@/lib/metadata/project-people";

/** The credential supplies the departing member; this operation has no body. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const scope = requireRequestScope(request);
    const { id } = await params;
    return NextResponse.json(leaveProject(scope, id));
  } catch (error) {
    return errorResponse(error);
  }
}
