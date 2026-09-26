import { NextResponse } from "next/server";
import { errorResponse, ApiError } from "@/lib/api/errors";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import {
  getConnection,
  connectionPassword,
  renameConnection,
  updateConnection,
  deleteConnection,
} from "@/lib/metadata/connections";
import { testConnection } from "@/lib/postgis/access";
import {
  ConnectionInputError,
  resolveUpdateConnectionInput,
} from "@/lib/postgis/connection-input";
import { recordConnectionHealth } from "@/lib/postgis/status";

type Params = { params: Promise<{ id: string }> };

/** Partially edit a connection. Connectivity changes are tested as a merged
 * candidate before any stored field is replaced. */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body) {
      throw new ApiError("invalid_request", "Expected a JSON body.", 400);
    }
    const current = getConnection(id);
    const password = connectionPassword(id);
    if (!current || password === null) {
      throw new ApiError("not_found", `No connection with id "${id}".`, 404);
    }
    let resolved;
    try {
      resolved = resolveUpdateConnectionInput(body, {
        name: current.name,
        host: current.host,
        port: current.port,
        database: current.database,
        username: current.username,
        password,
        ssl: current.ssl,
      });
    } catch (error) {
      if (error instanceof ConnectionInputError) {
        throw new ApiError("invalid_request", error.message, 400);
      }
      throw error;
    }

    const {
      values,
      connectivityChanged,
      passwordReentryRequired,
    } = resolved;
    if (passwordReentryRequired) {
      throw new ApiError(
        "connection_password_required",
        ERROR_CATALOGUE.connection_password_required,
        400,
      );
    }
    if (!connectivityChanged) {
      if (values.name !== current.name) renameConnection(id, values.name);
      return NextResponse.json(getConnection(id));
    }

    const health = await testConnection(values);
    const updated = updateConnection(id, values);
    if (!updated) {
      throw new ApiError("not_found", `No connection with id "${id}".`, 404);
    }
    recordConnectionHealth(id, health);
    return NextResponse.json(getConnection(id));
  } catch (error) {
    return errorResponse(error);
  }
}

/** Delete a connection. Imported snapshots stay; their refresh will say
 * the connection is gone. */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!deleteConnection(id)) {
      throw new ApiError("not_found", `No connection with id "${id}".`, 404);
    }
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
