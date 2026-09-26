import type { PgConnection, PgConnectionStatus } from "@/lib/metadata/connections";
import type { DataTable } from "@/lib/metadata/tables";
import { formatRelativeTime, readApiError } from "@/components/api";
import { serverUnreachable } from "@/components/failure-copy";

export interface ConnectionLedgerEntry {
  connection: PgConnection;
  snapshots: DataTable[];
}

export const STATUS_LABELS: Record<PgConnectionStatus, string> = {
  connected: "Connected",
  failing: "Failing",
  no_postgis: "No PostGIS",
  not_checked_lately: "Not checked lately",
  never_checked: "Never checked",
};

export function lastCheckLabel(connection: PgConnection): string {
  if (!connection.lastCheckedAt) return "never";
  const when = formatRelativeTime(connection.lastCheckedAt);
  return connection.status === "failing" ? `failed ${when}` : when;
}

export function serverAddress(connection: PgConnection): string {
  return `${connection.host}:${connection.port}/${connection.database}`;
}

/** The product and version alone ("PostgreSQL 18.6"): the stored value
 * carries the source's whole version sentence, which fits no card. */
export function shortServerVersion(serverVersion: string | null): string {
  if (!serverVersion) return "unknown";
  return serverVersion.split(" on ")[0].replace(/\s*\([^)]*\)/g, "").trim();
}

export async function fetchConnections(): Promise<PgConnection[]> {
  let response: Response;
  try {
    response = await fetch("/api/connections/postgis");
  } catch {
    throw new Error(serverUnreachable("load the connections"));
  }
  if (!response.ok) throw new Error(await readApiError(response));
  return (await response.json()) as PgConnection[];
}

export async function fetchSnapshots(connectionId: string): Promise<DataTable[]> {
  let response: Response;
  try {
    response = await fetch(`/api/connections/postgis/${connectionId}/snapshots`);
  } catch {
    throw new Error(serverUnreachable("load the connection's snapshots"));
  }
  if (!response.ok) throw new Error(await readApiError(response));
  const body = (await response.json()) as { snapshots: DataTable[] };
  return body.snapshots;
}

export async function fetchConnectionLedger(): Promise<ConnectionLedgerEntry[]> {
  const connections = await fetchConnections();
  return Promise.all(
    connections.map(async (connection) => ({
      connection,
      snapshots: await fetchSnapshots(connection.id),
    })),
  );
}
