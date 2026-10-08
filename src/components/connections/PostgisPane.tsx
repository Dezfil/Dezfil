"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PgConnection } from "@/lib/metadata/connections";
import type { DataTable } from "@/components/api";
import { formatRelativeTime, readApiError } from "@/components/api";
import { serverUnreachable } from "@/components/failure-copy";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { ChevronIcon } from "@/components/ui/icons";
import { RuledConnectionForm } from "./RuledConnectionForm";
import { fetchConnections, shortServerVersion } from "./connection-view";
import { PostgisDataDone, type PostgisDataCompletion } from "./PostgisDataDone";
import { PostgisLayerDone, type PostgisLayerCompletion } from "./PostgisLayerDone";
import { PostgisCatalogue } from "./PostgisCatalogue";
import { PostgisPicker } from "./PostgisPicker";
import { connectionLoadDestination } from "./postgis-pane-state";
import type { PostgisRemoteRelation } from "./postgis-pane-types";
import styles from "./PostgisPane.module.css";
import type { PostgisLayerOutcome } from "@/components/builder/use-layer-source-coordinator";

interface Props {
  context?: "adddata" | "addlayer";
  onTableCreated?: (table: DataTable) => void;
  /** A layer outcome settling after the user left the pending card — the
   * host's durable notice channel, so nothing vanishes (review). */
  onStaleLayerOutcome?: (message: string) => void;
  onLayerTableCreated?: (table: DataTable) => Promise<PostgisLayerOutcome>;
  onOpenTable?: (table: DataTable) => void;
  onDone?: () => void;
  initialConnectionId?: string | null;
  /** The import's project context: a filed map's catalog
   * passes its project so the created table files in the same act;
   * absent callers keep today's unfiled imports. */
  projectId?: string | null;
}

type Step =
  | { kind: "loading" }
  | { kind: "pick" }
  | { kind: "form" }
  | { kind: "browse"; connection: PgConnection }
  | { kind: "data_done"; completion: PostgisDataCompletion }
  | { kind: "layer_done"; completion: PostgisLayerCompletion };

function checkDetail(connection: PgConnection): string {
  if (connection.status === "failing" && connection.lastCheckError) {
    return connection.lastCheckError;
  }
  if (!connection.lastCheckedAt) return "Never checked";
  const when = formatRelativeTime(connection.lastCheckedAt);
  const postgres = connection.serverVersion
    ? shortServerVersion(connection.serverVersion)
    : "PostgreSQL version unknown";
  const postgis = connection.postgisVersion
    ? `PostGIS ${connection.postgisVersion}`
    : "PostGIS not installed";
  return `${connection.status === "not_checked_lately" ? "Last checked" : "Checked"} ${when} · ${postgres} · ${postgis}`;
}

export function PostgisPane({
  context = "adddata",
  onTableCreated,
  onLayerTableCreated,
  onStaleLayerOutcome,
  onOpenTable,
  onDone,
  initialConnectionId = null,
  projectId = null,
}: Props) {
  const [connections, setConnections] = useState<PgConnection[]>([]);
  const [step, setStep] = useState<Step>({ kind: "loading" });
  const [relations, setRelations] = useState<PostgisRemoteRelation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [storedFailure, setStoredFailure] = useState(false);
  const initialHandled = useRef(false);

  const replaceConnection = useCallback((connection: PgConnection) => {
    setConnections((current) =>
      current.map((item) => (item.id === connection.id ? connection : item)),
    );
    setStep((current) =>
      current.kind === "browse" && current.connection.id === connection.id
        ? { kind: "browse", connection }
        : current,
    );
  }, []);

  const syncConnection = useCallback(async (id: string) => {
    try {
      const fresh = await fetchConnections();
      setConnections(fresh);
      const connection = fresh.find((item) => item.id === id);
      if (connection) replaceConnection(connection);
    } catch {
      // The source operation already has its result. A secondary status
      // refresh must not replace it with an unrelated list failure.
    }
  }, [replaceConnection]);

  /** The freshest connection the pane holds. A completion captures the
   * connection as it stood when its import began, and that import's own
   * status sync lands after the capture, so returning to the catalogue
   * through a completion must re-read it or it restores health the import
   * has already replaced. */
  const latest = useCallback(
    (connection: PgConnection) =>
      connections.find((item) => item.id === connection.id) ?? connection,
    [connections],
  );

  const browse = useCallback(async (connection: PgConnection, force = false) => {
    setStep({ kind: "browse", connection });
    setRelations(null);
    setError(null);
    if (connection.status === "failing" && !force) {
      setStoredFailure(true);
      setError(connection.lastCheckError ?? "The last connection attempt failed.");
      return;
    }
    setStoredFailure(false);
    try {
      let response: Response;
      try {
        response = await fetch(`/api/connections/postgis/${connection.id}/tables`);
      } catch {
        throw new Error(serverUnreachable("read the catalogue"));
      }
      if (!response.ok) throw new Error(await readApiError(response));
      const body = (await response.json()) as { tables: PostgisRemoteRelation[] };
      setRelations(body.tables);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The catalogue could not be read.");
    }
    // No status re-read: the browse records no connection health, so the
    // stored detail shown above the catalogue still answers for the last
    // test, import or refresh.
  }, []);

  const enter = useCallback((fresh: PgConnection[]) => {
    setConnections(fresh);
    if (!initialHandled.current && initialConnectionId) {
      initialHandled.current = true;
      const selected = fresh.find((connection) => connection.id === initialConnectionId);
      if (selected) {
        void browse(selected);
        return;
      }
    }
    setStep((current) => {
      const destination = connectionLoadDestination(current.kind, fresh.length);
      return destination === "preserve" ? current : { kind: destination };
    });
  }, [browse, initialConnectionId]);

  const load = useCallback(async () => {
    setError(null);
    try {
      enter(await fetchConnections());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : serverUnreachable("load the connections"));
      setStep({ kind: "form" });
    }
  }, [enter]);

  useEffect(() => {
    let cancelled = false;
    fetchConnections()
      .then((fresh) => {
        if (!cancelled) enter(fresh);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(
          cause instanceof Error
            ? cause.message
            : serverUnreachable("load the connections"),
        );
        setStep({ kind: "form" });
      });
    return () => {
      cancelled = true;
    };
  }, [enter]);

  if (step.kind === "loading") {
    return <div className={styles.loading}>Loading connections…</div>;
  }

  return (
    <div className={styles.pane}>
      {step.kind === "data_done" ? (
        <PostgisDataDone
          completion={step.completion}
          onOpenTable={(table) => onOpenTable?.(table)}
          onImportAnother={() =>
            setStep({ kind: "browse", connection: latest(step.completion.connection) })
          }
        />
      ) : null}

      {step.kind === "layer_done" ? (
        <PostgisLayerDone
          completion={step.completion}
          onDone={() => onDone?.()}
          onImportAnother={() =>
            setStep({ kind: "browse", connection: latest(step.completion.connection) })
          }
        />
      ) : null}

      {step.kind === "pick" ? (
        <PostgisPicker
          connections={connections}
          onSelect={(connection) => void browse(connection)}
          onNew={() => setStep({ kind: "form" })}
        />
      ) : null}

      {step.kind === "form" ? (
        <div className={styles.formWrap}>
          <RuledConnectionForm
            mode="add"
            layout="stacked"
            onCancel={connections.length ? () => setStep({ kind: "pick" }) : undefined}
            cancelLabel="Back"
            onSaved={(connection) => {
              setConnections((current) => [...current, connection]);
              void browse(connection, true);
            }}
          />
        </div>
      ) : null}

      {step.kind === "browse" ? (
        <>
          <div className={styles.browseHead}>
            <button className={styles.back} type="button" onClick={() => setStep({ kind: "pick" })}>
              <ChevronIcon /> Connections
            </button>
            <div className={styles.connectionIdentity}>
              <strong>{step.connection.name}</strong>
              <span data-failing={step.connection.status === "failing" || undefined}>
                {checkDetail(step.connection)}
              </span>
            </div>
            <Link className={styles.manage} href="/connections">Manage</Link>
          </div>

          {error ? (
            <div className={styles.catalogueError}>
              <ErrorNote message={error} />
              {storedFailure ? (
                <Link className={styles.errorAction} href={`/connections/${step.connection.id}`}>
                  Edit connection
                </Link>
              ) : null}
              <button className={styles.errorAction} type="button" onClick={() => void browse(step.connection, true)}>
                Retry
              </button>
            </div>
          ) : null}
          {relations === null && !error ? <div className={styles.loading}>Reading the catalogue…</div> : null}
          {relations?.length === 0 ? <div className={styles.empty}>No tables visible to this user.</div> : null}
          {relations?.length ? (
            <PostgisCatalogue
              key={step.connection.id}
              connection={step.connection}
              relations={relations}
              onConnectionUsed={syncConnection}
              projectId={projectId}
              onTableCreated={async (table, relation, filter) => {
                const completion = {
                  connection: step.connection,
                  relation,
                  table,
                  filter,
                };
                if (context === "addlayer") {
                  if (!onLayerTableCreated) return;
                  // The card shows the moment the import lands; the coordinator's outcome settles
                  // into it, and only while this same completion is still showing.
                  setStep({
                    kind: "layer_done",
                    completion: { ...completion, outcome: { kind: "pending" } },
                  });
                  const outcome = await onLayerTableCreated(table);
                  setStep((current) => {
                    if (
                      current.kind === "layer_done" &&
                      current.completion.table.id === table.id
                    ) {
                      return {
                        kind: "layer_done",
                        completion: { ...current.completion, outcome },
                      };
                    }
                    // The user moved on before settlement: the outcome
                    // reports through the durable channel instead.
                    onStaleLayerOutcome?.(
                      outcome.kind === "created"
                        ? `Added ${outcome.layer.name} to this map`
                        : `${table.name} imported. ${outcome.message}`,
                    );
                    return current;
                  });
                  return;
                }
                onTableCreated?.(table);
                setStep({ kind: "data_done", completion });
              }}
            />
          ) : null}
        </>
      ) : null}

      {step.kind !== "browse" && error ? (
        <ErrorNote message={error} onRetry={() => void load()} />
      ) : null}
    </div>
  );
}
