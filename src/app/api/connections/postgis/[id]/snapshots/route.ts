import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { getConnection } from "@/lib/metadata/connections";
import { listPostgisSnapshots } from "@/lib/metadata/tables";
import { tableProjectIds } from "@/lib/metadata/projects";

type Params = { params: Promise<{ id: string }> };

/** List workspace snapshots by their stored connection id. */
export async function GET(_request: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!getConnection(id)) {
      throw new ApiError("not_found", `No connection with id "${id}".`, 404);
    }
    const memberships = tableProjectIds();
    return NextResponse.json({
      snapshots: listPostgisSnapshots(id).map((t) => ({
        ...t,
        projectIds: memberships.get(t.id) ?? [],
      })),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
