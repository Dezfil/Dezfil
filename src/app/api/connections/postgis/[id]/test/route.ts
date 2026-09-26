import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { requireTarget } from "@/lib/postgis/import";
import { testConnection } from "@/lib/postgis/access";
import { getConnection } from "@/lib/metadata/connections";
import {
  recordConnectionFailure,
  recordConnectionHealth,
} from "@/lib/postgis/status";

type Params = { params: Promise<{ id: string }> };

/** Re-test a saved connection. */
export async function POST(_request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const { target } = requireTarget(id);
    try {
      const health = await testConnection(target);
      recordConnectionHealth(id, health);
      return NextResponse.json(getConnection(id));
    } catch (error) {
      recordConnectionFailure(id, error);
      throw error;
    }
  } catch (error) {
    return errorResponse(error);
  }
}
