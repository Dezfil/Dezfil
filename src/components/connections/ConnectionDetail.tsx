"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { PgConnection } from "@/lib/metadata/connections";
import type { DataTable } from "@/lib/metadata/tables";
import { formatCount, formatRelativeTime, readApiError } from "@/components/api";
import { GeometryIcon, IconRefresh, geometryKind } from "@/components/gallery-icons";
import { Spinner } from "@/components/Spinner";
import { AsyncState, useAsync } from "@/components/ui/AsyncState";
import { IconButton } from "@/components/ui/IconButton";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { WarnIcon, XIcon } from "@/components/ui/icons";
import { AddDataDialog } from "@/components/AddDataDialog";
import { skippedNotice } from "@/components/skipped-members";
import { uploadSettleNotice } from "@/components/upload-settle-notice";
import { useUploadQueue, type UploadQueue } from "@/components/use-upload-queue";
import { RuledConnectionForm } from "./RuledConnectionForm";
import { contributePath, releasePath } from "@/components/shell/path-model";
import { PlainCrumbTail } from "@/components/shell/PlainCrumbTail";
import { ConnectionMenu } from "./ConnectionMenu";
import { ConnectionStatus } from "./ConnectionStatus";
import {
  fetchConnections,
  fetchSnapshots,
  lastCheckLabel,
  serverAddress,
  shortServerVersion,
} from "./connection-view";
import { refreshSequentially } from "./refresh-sequentially";
import styles from "./ConnectionDetail.module.css";

interface PageData {
  connection: PgConnection;
  snapshots: DataTable[];
}

type RefreshState =
  | { kind: "refreshing" }
  | { kind: "done" }
  | { kind: "failed"; message: string };

/** Cancel abandons the wait; the server was not asked to stop,
 * which is out of scope, and that one surprise is named here once. */
const CANCELLED_NOTICE =
  "Refresh cancelled. A refresh already running on the server may still finish.";

async function fetchPage(id: string): Promise<PageData> {
  const connections = await fetchConnections();
  const connection = connections.find((item) => item.id === id);
  if (!connection) throw new Error("This connection no longer exists.");
  return { connection, snapshots: await fetchSnapshots(id) };
}

function storedString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function storedNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function ConnectionDetail({ id }: { id: string }) {
  const router = useRouter();
  const { state, retry } = useAsync(() => fetchPage(id), id);
  const [savedConnection, setSavedConnection] = useState<PgConnection | null>(null);
  const [savedSnapshots, setSavedSnapshots] = useState<DataTable[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [testingError, setTestingError] = useState<string | null>(null);
  const [refreshStates, setRefreshStates] = useState<Record<string, RefreshState>>({});
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Import tables opens the Add data dialog HERE: no
  // navigation, and closing it leaves this page current. The file batch is
  // host-owned: an in-flight file survives the dialog and reports its
  // outcome on this page.
  const [addOpen, setAddOpen] = useState(false);
  const addOpenRef = useRef(addOpen);
  useEffect(() => {
    addOpenRef.current = addOpen;
  }, [addOpen]);
  const skipped = useRef(false);
  const uploadQueueRef = useRef<UploadQueue | null>(null);
  const rowAborts = useRef(new Map<string, AbortController>());
  const runAbort = useRef<AbortController | null>(null);
  const snapshotsReadSeq = useRef(0);
  const refreshSnapshots = useCallback(async () => {
    const seq = ++snapshotsReadSeq.current;
    try {
      const fresh = await fetchSnapshots(id);
      // An older read must not clobber a newer one (or a just-applied
      // import a newer read already carries).
      if (seq === snapshotsReadSeq.current) setSavedSnapshots(fresh);
    } catch {
      // The applied import stays visible; the reconciling read failing is
      // worth a sentence, not a lost row.
      setNotice("The snapshot list could not be re-read; showing what landed.");
    }
  }, [id]);
  const settleQueueForClose = useCallback(() => {
    const queue = uploadQueueRef.current;
    if (!queue) return;
    const stopped = queue.dismiss();
    if (stopped > 0) {
      setNotice(
        stopped === 1
          ? "Stopped. 1 queued file was not started."
          : `Stopped. ${stopped} queued files were not started.`,
      );
    }
    if (queue.current().settled) queue.reset();
  }, []);
  const uploadQueue = useUploadQueue({
    onSettled: (report) => {
      const { text, clean } = uploadSettleNotice(report);
      if (addOpenRef.current) {
        if (clean) {
          setAddOpen(false);
          setNotice(text);
        }
      } else {
        setNotice(text);
        uploadQueueRef.current?.reset();
      }
    },
  });
  useEffect(() => {
    uploadQueueRef.current = uploadQueue;
  }, [uploadQueue]);
  const closeAddDialog = useCallback(() => {
    settleQueueForClose();
    setAddOpen(false);
  }, [settleQueueForClose]);

  const syncConnection = useCallback(async () => {
    const latest = (await fetchConnections()).find((item) => item.id === id);
    if (latest) setSavedConnection(latest);
  }, [id]);

  // The shell's path model (on the road): the page contributes its name —
  // the plain tail renders, it never contributes — and re-contributes
  // after a rename; leaving releases it.
  const pathname = usePathname();
  const loadedName =
    state.status === "ready"
      ? (savedConnection ?? state.value.connection).name
      : null;
  useEffect(() => {
    if (loadedName === null) return;
    contributePath(pathname, { name: loadedName, projectId: null });
    return () => releasePath(pathname);
  }, [pathname, loadedName]);

  if (state.status !== "ready") {
    return (
      <div className={styles.screen}>
        <Link className={styles.back} href="/connections">‹ Connections</Link>
        <AsyncState state={state} onRetry={retry} pendingLabel="Reading connection…">
          {() => null}
        </AsyncState>
      </div>
    );
  }

  const connection = savedConnection ?? state.value.connection;
  const snapshots = savedSnapshots ?? state.value.snapshots;
  const refreshBlocked = connection.status === "failing";

  const test = async () => {
    setChecking(true);
    setTestingError(null);
    try {
      const response = await fetch(`/api/connections/postgis/${id}/test`, {
        method: "POST",
      });
      if (!response.ok) throw new Error(await readApiError(response));
      setSavedConnection((await response.json()) as PgConnection);
    } catch (error) {
      setTestingError(
        error instanceof Error ? error.message : "The connection test failed.",
      );
      try {
        await syncConnection();
      } catch {
        // The API sentence remains visible if the status follow-up cannot load.
      }
    } finally {
      setChecking(false);
    }
  };

  const refreshOne = async (name: string) => {
    // One operation per row: a Refresh all reaching a row the user already
    // set refreshing must not clobber its controller with a second
    // request (review).
    if (rowAborts.current.has(name)) return;
    const controller = new AbortController();
    rowAborts.current.set(name, controller);
    setRefreshStates((current) => ({
      ...current,
      [name]: { kind: "refreshing" },
    }));
    try {
      const response = await fetch(`/api/tables/${encodeURIComponent(name)}/refresh`, {
        method: "POST",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const refreshed = (await response.json()) as DataTable;
      setSavedSnapshots((current) =>
        (current ?? snapshots).map((snapshot) =>
          snapshot.name === name ? refreshed : snapshot,
        ),
      );
      setRefreshStates((current) => ({
        ...current,
        [name]: { kind: "done" },
      }));
    } catch (error) {
      if (controller.signal.aborted) {
        // Cancelled is not failed: the row returns to its stored facts,
        // and the reconciling read below picks up whatever the server
        // finished anyway.
        setRefreshStates((current) => {
          const { [name]: cancelled, ...rest } = current;
          void cancelled;
          return rest;
        });
        setNotice(CANCELLED_NOTICE);
        void refreshSnapshots();
      } else {
        setRefreshStates((current) => ({
          ...current,
          [name]: {
            kind: "failed",
            message: error instanceof Error ? error.message : "Refresh failed.",
          },
        }));
      }
      throw error;
    } finally {
      if (rowAborts.current.get(name) === controller) {
        rowAborts.current.delete(name);
      }
      try {
        await syncConnection();
      } catch {
        // A status-read failure does not change the refresh result already shown.
      }
    }
  };

  const refreshAll = async () => {
    const controller = new AbortController();
    runAbort.current = controller;
    setRefreshingAll(true);
    await refreshSequentially(
      snapshots.map((snapshot) => snapshot.name),
      refreshOne,
      undefined,
      controller.signal,
    );
    runAbort.current = null;
    setRefreshingAll(false);
  };

  const cancelRefreshes = () => {
    runAbort.current?.abort();
    for (const controller of rowAborts.current.values()) controller.abort();
    setNotice(CANCELLED_NOTICE);
  };

  const remove = async () => {
    const response = await fetch(`/api/connections/postgis/${id}`, {
      method: "DELETE",
    });
    if (!response.ok && response.status !== 404) {
      setTestingError(await readApiError(response));
      return;
    }
    router.push("/connections");
  };

  return (
    <div className={styles.screen}>
      <PlainCrumbTail name={connection.name} />
      <Link className={styles.back} href="/connections">‹ Connections</Link>

      <header className={styles.detailHead}>
        <span className={styles.logoTile}>
          {/* eslint-disable-next-line @next/next/no-img-element -- static SVG, PostgreSQL elephant mark (see NOTICE) */}
          <img src="/logos/postgresql.svg" alt="" />
        </span>
        <div className={styles.title}>
          <div className={styles.titleLine}>
            <h1>{connection.name}</h1>
            <ConnectionStatus connection={connection} checking={checking} />
          </div>
          <p title={serverAddress(connection)}>{serverAddress(connection)}</p>
          <small>
            {connection.status === "failing"
              ? connection.lastCheckError ?? "The last connection check failed."
              : connection.status === "no_postgis"
                ? "Connected. PostGIS is not installed."
                : connection.status === "never_checked"
                  ? "This connection has never been checked."
                  : `Last checked ${lastCheckLabel(connection)}`}
          </small>
        </div>
        <div className={styles.headActions}>
          <button
            className={styles.importButton}
            type="button"
            onClick={() => {
              skipped.current = false;
              setAddOpen(true);
            }}
          >
            Import tables
          </button>
          <button
            className={styles.testButton}
            type="button"
            disabled={checking}
            onClick={() => void test()}
          >
            {checking ? "Testing" : "Test now"}
          </button>
          <ConnectionMenu
            connection={connection}
            snapshotCount={snapshots.length}
            showImport={false}
            onDelete={() => void remove()}
            onCopied={(address) => setNotice(`Copied ${address}`)}
          />
        </div>
      </header>

      {testingError ? (
        <ErrorNote message={testingError} onDismiss={() => setTestingError(null)} />
      ) : null}
      {notice ? <p className={styles.notice} role="status">{notice}</p> : null}

      <div className={styles.detailGrid}>
        <div className={styles.mainColumn}>
          <section className={styles.card}>
            <div className={styles.cardHead}>
              <h2>Snapshots</h2>
              <span>{snapshots.length ? `${snapshots.length} table${snapshots.length === 1 ? "" : "s"} in your workspace` : ""}</span>
              <span className={styles.cardHeadActions}>
                <button
                  className={styles.refreshAll}
                  type="button"
                  data-busy={refreshingAll || undefined}
                  disabled={!snapshots.length || refreshBlocked || refreshingAll}
                  onClick={() => void refreshAll()}
                >
                  <IconRefresh /> {refreshingAll ? "Refreshing" : "Refresh all"}
                </button>
                {refreshingAll ? (
                  <button
                    className={styles.refreshAll}
                    type="button"
                    onClick={cancelRefreshes}
                  >
                    Cancel
                  </button>
                ) : null}
              </span>
            </div>
            {refreshBlocked ? (
              <div className={styles.blocked} role="alert">
                <WarnIcon />
                Refresh is blocked until the connection works: {connection.lastCheckError ?? "The connection is failing."}
              </div>
            ) : connection.status === "no_postgis" ? (
              <div className={styles.warning}>
                <WarnIcon />
                PostGIS is not installed on this server. Attribute tables can still be imported.
              </div>
            ) : null}
            {snapshots.length ? (
              <div className={styles.snapshotList}>
                {snapshots.map((snapshot) => {
                  const refresh = refreshStates[snapshot.name];
                  const params = snapshot.sourceParams;
                  const schema = storedString(params?.schema);
                  const table = storedString(params?.table);
                  const filter = storedString(params?.filter);
                  const limit = storedNumber(params?.limit);
                  return (
                    <div className={styles.snapshotRow} key={snapshot.id}>
                      <span className={styles.geometry}>
                        <GeometryIcon kind={geometryKind(snapshot.geometryType, snapshot.geometryColumn)} />
                      </span>
                      <span className={styles.snapshotMain}>
                        <b>{snapshot.name}</b>
                        <small>
                          from <code>{schema && table ? `${schema}.${table}` : "stored source"}</code>
                          {filter ? <span>WHERE {filter}</span> : null}
                          {limit !== null ? <span>LIMIT {formatCount(limit)}</span> : null}
                        </small>
                      </span>
                      <span className={styles.snapshotMeta}>
                        {refresh?.kind === "refreshing" ? (
                          <span className={styles.rowBusy} role="status">
                            <Spinner size={10} /> refreshing…
                          </span>
                        ) : refresh?.kind === "failed" ? (
                          <span data-failed title={refresh.message}>refresh failed</span>
                        ) : (
                          <>{formatCount(snapshot.rowCount)} rows · refreshed {snapshot.importedAt ? formatRelativeTime(snapshot.importedAt) : "never"}</>
                        )}
                      </span>
                      <span className={styles.snapshotActions}>
                        {refresh?.kind === "refreshing" ? (
                          <IconButton
                            action={`Cancel refreshing ${snapshot.name}`}
                            icon={<XIcon />}
                            onClick={() => rowAborts.current.get(snapshot.name)?.abort()}
                          />
                        ) : (
                          <IconButton
                            action={`Refresh ${snapshot.name}`}
                            icon={<IconRefresh />}
                            disabled={refreshBlocked || refreshingAll}
                            onClick={() => void refreshOne(snapshot.name).catch(() => {})}
                          />
                        )}
                        <Link href={`/tables/${encodeURIComponent(snapshot.name)}`}>
                          Open in Data
                        </Link>
                      </span>
                      {refresh?.kind === "failed" ? (
                        <p className={styles.rowError} role="alert">{refresh.message}</p>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className={styles.snapshotEmpty}>
                <p>No snapshots yet.</p>
                <button
                  type="button"
                  onClick={() => {
                    skipped.current = false;
                    setAddOpen(true);
                  }}
                >
                  Import tables
                </button>
              </div>
            )}
          </section>
        </div>

        <aside className={styles.sideColumn}>
          <section className={styles.card}>
            <div className={styles.cardHead}>
              <h2>Settings</h2>
              <span>Saving re-tests the connection</span>
            </div>
            <div className={styles.cardBody}>
              <RuledConnectionForm
                mode="edit"
                connection={connection}
                layout="stacked"
                title={false}
                onSaved={(updated) => {
                  setSavedConnection(updated);
                  setNotice(`${updated.name} updated`);
                }}
              />
            </div>
          </section>

          <section className={styles.card}>
            <div className={styles.cardHead}><h2>About</h2></div>
            <div className={styles.cardBody}>
              <dl className={styles.facts}>
                <dt>Created</dt><dd>{new Date(connection.createdAt).toLocaleString()}</dd>
                <dt>Last check</dt><dd>{connection.lastCheckedAt ? `${new Date(connection.lastCheckedAt).toLocaleString()}${connection.status === "failing" ? ", failed" : ""}` : "never"}</dd>
                <dt>Server</dt><dd title={connection.serverVersion ?? undefined}>{shortServerVersion(connection.serverVersion)}</dd>
                <dt>PostGIS</dt><dd>{connection.postgisVersion ?? (connection.status === "no_postgis" ? "not installed" : "unknown")}</dd>
                <dt>Encryption</dt><dd>{connection.ssl ? "SSL required" : "SSL not required"}</dd>
                <dt>Id</dt><dd className={styles.identifier}>{connection.id}</dd>
              </dl>
            </div>
          </section>

          <section className={`${styles.card} ${styles.dangerCard}`}>
            <div className={styles.cardHead}><h2>Delete connection</h2></div>
            <div className={styles.cardBody}>
              <p>
                {snapshots.length
                  ? `${snapshots.length === 1 ? "Its snapshot keeps" : `Its ${snapshots.length} snapshots keep`} the data already imported, but ${snapshots.length === 1 ? "it" : "they"} can no longer refresh.`
                  : "No snapshots depend on it."}
              </p>
              {confirmingDelete ? (
                <span className={styles.deleteConfirm}>
                  <button type="button" data-danger onClick={() => void remove()}>
                    Confirm delete
                  </button>
                  <button type="button" onClick={() => setConfirmingDelete(false)}>
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  className={styles.deleteButton}
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                >
                  Delete {connection.name}
                </button>
              )}
            </div>
          </section>
        </aside>
      </div>

      <AddDataDialog
        open={addOpen}
        onClose={closeAddDialog}
        onTableCreated={(table) => {
          settleQueueForClose();
          setAddOpen(false);
          if (!skipped.current) setNotice(`${table.name} is ready.`);
        }}
        onPostgisTableCreated={(table) => {
          // The landed table shows immediately; the server list reconciles
          // behind it (review).
          setSavedSnapshots((current) => [
            ...(current ?? state.value.snapshots),
            table,
          ]);
          void refreshSnapshots();
        }}
        onSkipped={(s) => {
          skipped.current = s.length > 0;
          setNotice(s.length ? skippedNotice(s) : null);
        }}
        uploadQueue={uploadQueue}
        initialPostgisConnectionId={id}
      />
    </div>
  );
}
