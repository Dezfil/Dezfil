import { requireOwnedResource } from "@/lib/auth/owned-resource";
import type { AccountScope } from "@/lib/auth/scope";
import { ApiError } from "@/lib/api/errors";
import {
  recordConnectionCheck,
  type PgConnection,
} from "@/lib/metadata/connections";
import type { ConnectionHealth } from "./access";

const AUTH_FAILURE = "Authentication failed. Check the username and password.";
const DATABASE_FAILURE = "The database does not exist on that server.";
const UNREACHABLE_FAILURE =
  "The server is unreachable. Check host, port, and network.";

/** Reduce engine failures to credential-free sentences before persistence. */
export function connectionFailureSentence(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/password authentication|authentication failed/i.test(message)) {
    return AUTH_FAILURE;
  }
  if (/database .* does not exist/i.test(message)) return DATABASE_FAILURE;
  if (
    /timeout|timed out|could not connect|connection refused|no route|could not translate|unreachable/i.test(
      message,
    )
  ) {
    return UNREACHABLE_FAILURE;
  }
  if (error instanceof ApiError && error.code === "egress_blocked") {
    return UNREACHABLE_FAILURE;
  }
  return "The connection failed while accessing the source.";
}

export function recordConnectionHealth(
  scope: AccountScope,
  id: string,
  health: ConnectionHealth,
): void {
  recordConnectionCheck(scope, id, {
    outcome: health.postgisVersion ? "connected" : "no_postgis",
    serverVersion: health.serverVersion,
    postgisVersion: health.postgisVersion,
  });
}

export function isConnectionLevelFailure(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    (error.code === "connection_failed" || error.code === "egress_blocked")
  );
}

export function recordConnectionFailure(scope: AccountScope, id: string, error: unknown): void {
  requireOwnedResource(scope, "connection", id);
  if (!isConnectionLevelFailure(error)) return;
  recordConnectionFailureMessage(scope, id, connectionFailureSentence(error));
}

export function recordConnectionFailureMessage(
  scope: AccountScope,
  id: string,
  message: string,
): void {
  recordConnectionCheck(scope, id, {
    outcome: "failing",
    error: message,
  });
}

export function statusBlocksRefresh(connection: PgConnection): boolean {
  return connection.status === "failing";
}
