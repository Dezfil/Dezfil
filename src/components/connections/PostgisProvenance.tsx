"use client";

import Link from "next/link";
import type { DataTable } from "@/components/api";
import type { PgConnection } from "@/lib/metadata/connections";
import { useAsync, type Async } from "@/components/ui/AsyncState";
import { fetchConnections } from "./connection-view";

export function PostgisProvenanceView({
  table,
  state,
}: {
  table: DataTable;
  state: Async<PgConnection[]>;
}) {
  const connectionId = String(table.sourceParams?.connectionId ?? "");
  const storedName = String(table.sourceParams?.connectionName ?? "?");
  const schema = String(table.sourceParams?.schema ?? "");
  const sourceTable = String(table.sourceParams?.table ?? "");

  if (state.status !== "ready") {
    return <>Snapshot of {schema}.{sourceTable}</>;
  }

  const live = state.value.find(
    (connection) => connection.id === connectionId,
  );
  return (
    <>
      Snapshot of {schema}.{sourceTable} from {live ? (
        <Link href={`/connections/${live.id}`}>&quot;{live.name}&quot;</Link>
      ) : (
        <>&quot;{storedName}&quot;</>
      )}
    </>
  );
}

/** A live connection owns its current name and URL. Once it is deleted,
 * the snapshot's stored display name remains provenance text only. */
export function PostgisProvenance({ table }: { table: DataTable }) {
  const connectionId = String(table.sourceParams?.connectionId ?? "");
  const { state } = useAsync(fetchConnections, `provenance:${connectionId}`);
  return <PostgisProvenanceView table={table} state={state} />;
}
