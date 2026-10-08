"use client";

import Link from "next/link";
import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { PgConnection } from "@/lib/metadata/connections";
import { formatCount, readApiError } from "@/components/api";
import { IconSearch } from "@/components/gallery-icons";
import { PlusIcon } from "@/components/ui/icons";
import { AsyncState } from "@/components/ui/AsyncState";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { ListHeading } from "@/components/ListHeading";
import { headingLine } from "@/components/scope/model";
import { useAsyncCollection } from "@/components/use-async-collection";
import { useSearchShortcut } from "@/components/use-search-shortcut";
import { useTransientNotice } from "@/components/use-transient-notice";
import { useRuleRefusal } from "@/components/use-instance-rules";
import { serverUnreachable } from "@/components/failure-copy";
import gallery from "@/components/gallery.module.css";
import { ConnectionMenu } from "./ConnectionMenu";
import { ConnectionStatus } from "./ConnectionStatus";
import {
  fetchConnectionLedger,
  fetchConnections,
  lastCheckLabel,
  type ConnectionLedgerEntry,
} from "./connection-view";
import {
  filterConnections,
  sortConnections,
  type ConnectionsSort,
} from "./ledger-model";
import styles from "./ConnectionsLedger.module.css";

export function ConnectionsLedger() {
  const router = useRouter();
  const { state, retry, mutate } = useAsyncCollection<ConnectionLedgerEntry>(
    fetchConnectionLedger,
    "connections-ledger",
  );
  const [checking, setChecking] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { notice, show: showNotice } = useTransientNotice();
  // Who may add database connections: when the instance's rule holds the
  // person back, Add connection is drawn disabled with its sentence; the
  // connections listed keep every action they have.
  const refusal = useRuleRefusal("connections.create");
  // The toolbar the reference gives the page: a search that narrows by
  // name and the Recently checked sort, present from zero. The sort is
  // page state, not a workspace setting: the settings' view-preference
  // contract names the four gallery screens and is not widened here.
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ConnectionsSort>("checked");
  const searchRef = useRef<HTMLInputElement>(null);
  useSearchShortcut(searchRef);
  const entries = state.status === "ready" ? state.value : null;
  const shown = useMemo(
    () =>
      entries ? sortConnections(filterConnections(entries, query), sort) : null,
    [entries, query, sort],
  );

  const test = useCallback(async (connection: PgConnection) => {
    setChecking(connection.id);
    setActionError(null);
    try {
      const response = await fetch(`/api/connections/postgis/${connection.id}/test`, {
        method: "POST",
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const updated = (await response.json()) as PgConnection;
      mutate((entries) =>
        entries.map((entry) =>
          entry.connection.id === connection.id
            ? { ...entry, connection: updated }
            : entry,
        ),
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : serverUnreachable("test the connection");
      setActionError(message);
      try {
        const refreshed = (await fetchConnections()).find(
          (item) => item.id === connection.id,
        );
        if (refreshed) {
          mutate((entries) =>
            entries.map((entry) =>
              entry.connection.id === connection.id
                ? { ...entry, connection: refreshed }
                : entry,
            ),
          );
        }
      } catch {
        // The test sentence remains visible; the existing row is still true
        // to the last list response when the follow-up status read fails.
      }
    } finally {
      setChecking(null);
    }
  }, [mutate]);

  const remove = useCallback(async (connection: PgConnection) => {
    setActionError(null);
    try {
      const response = await fetch(`/api/connections/postgis/${connection.id}`, {
        method: "DELETE",
      });
      if (!response.ok && response.status !== 404) {
        throw new Error(await readApiError(response));
      }
      mutate((entries) =>
        entries.filter((entry) => entry.connection.id !== connection.id),
      );
      showNotice(`${connection.name} deleted`);
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "The connection couldn't be deleted.",
      );
    }
  }, [mutate, showNotice]);

  return (
    <div className={styles.screen}>
      {/* The one heading: Connections gains the count it never had,
          silent until the read resolves, and loses its sentence; the
          line appears only when the search narrows the list, in the
          shared wording. */}
      <ListHeading
        title="Connections"
        line={
          entries && shown
            ? headingLine({
                scopedTotal: entries.length,
                scope: { kind: "all" },
                scopeName: null,
                shownCount: shown.length,
              })
            : null
        }
        note={refusal}
        action={
          refusal
            ? { label: "Add connection", onClick: () => {}, disabled: true }
            : { label: "Add connection", href: "/connections/new" }
        }
      />

      {actionError ? (
        <ErrorNote message={actionError} onDismiss={() => setActionError(null)} />
      ) : null}
      {notice ? <p className={styles.notice} role="status">{notice}</p> : null}

      <div className={gallery.toolbar}>
        <label className={gallery.search}>
          <IconSearch />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search connections…"
            aria-label="Search connections"
          />
          <kbd>/</kbd>
        </label>
        <div className={gallery.tail}>
          <label className={gallery.sort}>
            Sort
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as ConnectionsSort)}
              aria-label="Sort connections"
            >
              <option value="checked">Recently checked</option>
              <option value="name">Name A–Z</option>
            </select>
          </label>
        </div>
      </div>

      <AsyncState state={state} onRetry={retry} pendingLabel="Reading your connections…">
        {(entries) => entries.length === 0 ? (
          <div className={gallery.emptyAction}>
            <button className={gallery.ghost} disabled={!!refusal} onClick={() => router.push("/connections/new")}>
              <span className={gallery.plus}><PlusIcon /></span>
              <b>Add connection</b>
              <small>Snapshot tables from a PostGIS database</small>
            </button>
          </div>
        ) : !shown || shown.length === 0 ? (
          <p className={gallery.empty}>No connections match. Clear the search.</p>
        ) : (
          <div className={`${gallery.listCard} ${styles.ledger}`}>
            <div className={`${gallery.listHead} ${styles.ledgerHead}`} aria-hidden>
              <span>Connection</span>
              <span>Database</span>
              <span>Status</span>
              <span>Snapshots</span>
              <span>Last check</span>
              <span />
            </div>
            {shown.map(({ connection, snapshots }) => (
              <div className={styles.row} key={connection.id}>
                <Link
                  className={styles.rowLink}
                  href={`/connections/${connection.id}`}
                  aria-label={`Open ${connection.name}`}
                >
                  <span className={styles.nameCell}>
                    <span className={styles.logoTile}>
                      {/* eslint-disable-next-line @next/next/no-img-element -- static SVG, PostgreSQL elephant mark (see NOTICE) */}
                      <img src="/logos/postgresql.svg" alt="" />
                    </span>
                    <span>
                      <b>{connection.name}</b>
                      <small title={`${connection.host}:${connection.port}`}>{connection.host}:{connection.port}</small>
                    </span>
                  </span>
                  <span className={styles.databaseCell}>
                    {connection.database}
                    <small>{connection.username} · {connection.ssl ? "SSL required" : "SSL not required"}</small>
                  </span>
                  <ConnectionStatus
                    connection={connection}
                    checking={checking === connection.id}
                  />
                  <span className={styles.count}>{snapshots.length ? formatCount(snapshots.length) : "—"}</span>
                  <span className={styles.when}>{lastCheckLabel(connection)}</span>
                  <span />
                </Link>
                <span className={styles.actions}>
                  <button
                    className={styles.testButton}
                    type="button"
                    onClick={() => void test(connection)}
                    disabled={checking === connection.id}
                  >
                    Test
                  </button>
                  <ConnectionMenu
                    connection={connection}
                    snapshotCount={snapshots.length}
                    onDelete={() => void remove(connection)}
                    onCopied={(address) => showNotice(`Copied ${address}`)}
                  />
                </span>
              </div>
            ))}
          </div>
        )}
      </AsyncState>
    </div>
  );
}
