import { withTrustedMutation } from "@/lib/trusted-mutation";
import { randomUUID } from "node:crypto";
import { ApiError } from "@/lib/api/errors";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import { requireRule } from "@/lib/auth/instance-rules";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { requireOwnedResource, resourceAbsent } from "@/lib/auth/owned-resource";
import { metadataDb } from "@/lib/metadata/db";
import { getConnection, insertConnection, renameConnection, updateConnection, deleteConnection } from "@/lib/metadata/connections";
import { listPostgisSnapshots } from "@/lib/metadata/tables";
import { reachedTableProjectIds } from "@/lib/metadata/owned-tables";
import { testConnection, browseRemoteTables } from "./access";
import { ConnectionInputError, connectionEndpointsEqual, resolveCreateConnectionInput, resolveUpdateConnectionInput, type ConnectionEndpoint } from "./connection-input";
import { requireTarget } from "./import";
import { recordConnectionFailure, recordConnectionHealth } from "./status";

function resolveInput<T>(resolve: () => T): T {
  try { return resolve(); } catch (error) {
    if (error instanceof ConnectionInputError) throw new ApiError("invalid_request", error.message, 400);
    throw error;
  }
}
function jsonBody(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ApiError("invalid_request", "Expected a JSON body.", 400);
  return input as Record<string, unknown>;
}
export function requireConnection(scope: AccountScope, id: string) {
  const connection = getConnection(scope, id);
  if (!connection) throw resourceAbsent();
  return connection;
}
/** Pointing a connection at another host, port or database reaches a new
 * source, as adding one does; its name, user, password and encryption do not. */
function pointsElsewhere(stored: ConnectionEndpoint & { database: string }, next: ConnectionEndpoint & { database: string }): boolean {
  return !connectionEndpointsEqual(stored, next) || stored.database !== next.database;
}
/** Who may add connections is refused before the test reaches the typed
 * source, and decided again inside the write, so a rule saved while the test
 * ran is the one that holds. */
export async function createConnection(scope: AccountScope, input: unknown, signal?: AbortSignal) {
  return withTrustedMutation({ kind: "interactive-read", name: "PostGIS connection", signal }, async operation => {
    requireAccountScope(scope);
    requireRule(scope.accountId, "connections.create");
    const values = resolveInput(() => resolveCreateConnectionInput(jsonBody(input)));
    const candidate = { id: randomUUID(), ...values };
    const health = await testConnection(candidate);
    const db = metadataDb();
    const connection = db.transaction(() => {
      requireRule(scope.accountId, "connections.create", db);
      operation.assertCanCommit();
      return insertConnection(scope, candidate, db);
    }).immediate();
    recordConnectionHealth(scope, connection.id, health);
    return requireConnection(scope, connection.id);
  });
}
export async function editConnection(scope: AccountScope, id: string, input: unknown, signal?: AbortSignal) {
  return withTrustedMutation({ kind: "interactive-read", name: "PostGIS connection", signal }, async operation => {
    const { connection: current, target } = requireTarget(scope, id);
    const { values, connectivityChanged, passwordReentryRequired } = resolveInput(() => resolveUpdateConnectionInput(jsonBody(input), { ...target, name: current.name }));
    if (pointsElsewhere(target, values)) requireRule(scope.accountId, "connections.create");
    if (passwordReentryRequired) throw new ApiError("connection_password_required", ERROR_CATALOGUE.connection_password_required, 400);
    if (!connectivityChanged) {
      if (values.name !== current.name) renameConnection(scope, id, values.name);
      return requireConnection(scope, id);
    }
    const health = await testConnection(values);
    const db = metadataDb();
    db.transaction(() => {
      const stored = getConnection(scope, id, db);
      if (stored && pointsElsewhere(stored, values)) requireRule(scope.accountId, "connections.create", db);
      operation.assertCanCommit();
      updateConnection(scope, id, values, db);
    }).immediate();
    recordConnectionHealth(scope, id, health);
    return requireConnection(scope, id);
  });
}
export function removeConnection(scope: AccountScope, id: string): void {
  if (!deleteConnection(scope, id)) throw resourceAbsent();
}
export async function testSavedConnection(scope: AccountScope, id: string, signal?: AbortSignal) {
  return withTrustedMutation({ kind: "interactive-read", name: "PostGIS connection", signal }, async operation => {
    const { target } = requireTarget(scope, id);
    try {
      const health = await testConnection(target);
      operation.assertCanCommit();
      recordConnectionHealth(scope, id, health);
      return requireConnection(scope, id);
    } catch (error) {
      recordConnectionFailure(scope, id, error);
      throw error;
    }
  });
}
export async function browseConnection(scope: AccountScope, id: string, signal?: AbortSignal) {
  return withTrustedMutation({ kind: "interactive-read", name: "PostGIS connection", signal }, async operation => {
    const { target } = requireTarget(scope, id);
    const { tables } = await browseRemoteTables(target);
    requireOwnedResource(scope, "connection", id);
    operation.assertCanCommit();
    return { tables };
  });
}
export function connectionSnapshots(scope: AccountScope, id: string) {
  requireOwnedResource(scope, "connection", id);
  const memberships = reachedTableProjectIds(scope);
  return { snapshots: listPostgisSnapshots(scope, id).map(t => ({ ...t, projectIds: memberships.get(t.id) ?? [] })) };
}
