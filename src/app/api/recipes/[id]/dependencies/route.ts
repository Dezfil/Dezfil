import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { workflowDependencies } from "@/lib/recipe-dependencies";

type Params = { params: Promise<{ id: string }> };

/** The datasets a workflow reads and writes: the
 * filing checklist's documented read for a workflow. */
export async function GET(_request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(_request);
    const { id } = await params;
    return NextResponse.json({ datasets: await workflowDependencies(scope, id) });
  } catch (error) {
    return errorResponse(error);
  }
}
