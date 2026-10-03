import { largeJsonValue } from "@/lib/api/json-body";
import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { requireRequestScope } from "@/lib/auth/scope-http";
import { removeProjectPerson, setProjectPerson, type PersonRole } from "@/lib/metadata/project-people";

type Params = { params: Promise<{ id: string; sqlName: string }> };

async function roleOf(request: Request): Promise<PersonRole> {
  let body: unknown;
  try {
    body = await largeJsonValue(request);
  } catch (error) {
      if (error instanceof ApiError) throw error;
    throw new ApiError("invalid_request", "Expected a JSON body.", 400);
  }
  const role = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).role : undefined;
  if (role !== "viewer" && role !== "editor") {
    throw new ApiError("invalid_request", '"role" must be "viewer" or "editor".', 400);
  }
  return role;
}

/** Give the person a role on the project: the project owner's act. */
export async function PUT(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    const { id, sqlName } = await params;
    const role = await roleOf(request);
    return NextResponse.json({ people: setProjectPerson(scope, id, sqlName, role) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Take the person off the project: the project owner's act. */
export async function DELETE(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    const { id, sqlName } = await params;
    return NextResponse.json({ people: removeProjectPerson(scope, id, sqlName) });
  } catch (error) {
    return errorResponse(error);
  }
}
