import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { errorResponse, ApiError } from "@/lib/api/errors";
import {
  insertConnection,
  listConnections,
  getConnection,
} from "@/lib/metadata/connections";
import { testConnection } from "@/lib/postgis/access";
import {
  ConnectionInputError,
  resolveCreateConnectionInput,
} from "@/lib/postgis/connection-input";
import { recordConnectionHealth } from "@/lib/postgis/status";

/** List saved PostGIS connections — never includes passwords. */
export async function GET() {
  try {
    return NextResponse.json(listConnections());
  } catch (error) {
    return errorResponse(error);
  }
}

/** Create a connection: tested first, saved only on success. */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body) {
      throw new ApiError("invalid_request", "Expected a JSON body.", 400);
    }
    let values;
    try {
      values = resolveCreateConnectionInput(body);
    } catch (error) {
      if (error instanceof ConnectionInputError) {
        throw new ApiError("invalid_request", error.message, 400);
      }
      throw error;
    }
    const candidate = {
      id: randomUUID(),
      ...values,
    };
    // Nothing "working" is ever stored untested.
    const health = await testConnection(candidate);
    const connection = insertConnection(candidate);
    recordConnectionHealth(connection.id, health);
    return NextResponse.json(getConnection(connection.id), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
