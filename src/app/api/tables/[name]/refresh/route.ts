import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { errorResponse, ApiError } from "@/lib/api/errors";
import { refreshTable } from "@/lib/ingest/refresh";
import { reachedTableProjectIds } from "@/lib/metadata/owned-tables";
import { requireOwnDataset } from "@/lib/dataset-address";

type Params = { params: Promise<{ name: string }> };

/** Re-run a table's stored import atomically (spec refresh;
 * optional explicit release update for Overture tables). */
export async function POST(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    // Refreshing is the owner's: another person's dataset is refused by the
    // permission shape, whichever address names it.
    const name = requireOwnDataset(scope, (await params).name).table.name;
    const body = (await request.json().catch(() => null)) as {
      release?: unknown;
    } | null;
    if (
      body?.release !== undefined &&
      typeof body.release !== "string"
    ) {
      throw new ApiError(
        "invalid_request",
        'The optional "release" field must be a string.',
        400,
      );
    }
    const refreshed = await refreshTable(
      scope,
      name,
      body?.release ? { release: body.release } : {},
    );
    // A refresh keeps the identity, so the memberships it kept ride the
    // answer like every Table-shaped response.
    return NextResponse.json({
      ...refreshed,
      projectIds: reachedTableProjectIds(scope).get(refreshed.id) ?? [],
    });
  } catch (error) {
    return errorResponse(error);
  }
}
