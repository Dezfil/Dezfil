"use client";

import { editHeaders } from "@/lib/edit-basis";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { MapOverview } from "./api";
import { formatRelativeTime, readApiError } from "./api";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { ErrorNote } from "./ui/ErrorNote";
import { PlusIcon } from "./ui/icons";
import { StatusDot, StatusLine } from "./ui/Status";
import { MapStrip } from "./MapStrip";
import gallery from "./gallery.module.css";
import styles from "./AddToMapDialog.module.css";
import { serverUnreachable } from "./failure-copy";
import { tableReference } from "./sql/sql-draft";

/** What lands as the layer when a map is picked (spec the dialog
 * is SQL-scoped — tables and query results walk through the same door). */
export interface LayerSubject {
  /** The SQL that becomes the layer's truth. */
  sql: string;
  /** The layer name to land with. */
  name: string;
  /** Short label for the dialog copy ("<label> becomes a layer …"). */
  label: string;
}

/** The table cards' subject: the dataset as its reader types it (its
 * `qualifiedName`, a keyword part quoted), so another person's same-named
 * dataset is never the one that lands. The layer and the label take the
 * dataset's own name. */
export function tableSubject(reference: string | null): LayerSubject | null {
  if (reference === null) return null;
  const name = reference.slice(reference.lastIndexOf(".") + 1);
  return {
    sql: `SELECT * FROM ${tableReference(reference)}`,
    name,
    label: name,
  };
}

/** The layer a landing creates: both subjects are written as the console
 * reads them (the caller's own datasets plain, another person's
 * qualified), and the server carries them into the picked map's home. */
export function landingRequest(subject: LayerSubject, layerName: string) {
  return { name: layerName.trim() || subject.name, sql: subject.sql, writtenIn: { kind: "console" as const } };
}

interface Props {
  /** What to land; null keeps the dialog closed. */
  subject: LayerSubject | null;
  onClose: () => void;
}

/**
 * "Add to a map" (SQL-scoped; a gallery): pick an existing map — or a new
 * one — and the subject lands on it as a layer; the builder opens on that
 * map. The maps are small cards in a grid, the Maps screen's card at the
 * dialog's size: snapshot or placeholder, name, layer count, edited time
 * and state.
 */
export function AddToMapDialog({ subject, onClose }: Props) {
  const router = useRouter();
  const [maps, setMaps] = useState<MapOverview[] | null>(null);
  // A load failure retries; a landing failure dismisses.
  const [error, setError] = useState<{
    message: string;
    retryable: boolean;
  } | null>(null);
  const [attempt, setAttempt] = useState(1);
  const [busy, setBusy] = useState(false);
  // The usual editable name field — the parent keys the dialog by
  // subject, so the default binds once per open.
  const [layerName, setLayerName] = useState(subject?.name ?? "");

  const open = subject !== null;

  // The parent keys this dialog by table, so every open mounts fresh state.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        let response: Response;
        try {
          response = await fetch("/api/maps");
        } catch {
          throw new Error(serverUnreachable("load the maps"));
        }
        if (!response.ok) throw new Error(await readApiError(response));
        const body = (await response.json()) as MapOverview[];
        if (!cancelled) {
          setMaps(body);
          setError(null);
        }
      } catch (e) {
        if (!cancelled)
          setError({
            message:
              e instanceof Error
                ? e.message
                : serverUnreachable("load the maps"),
            retryable: true,
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, attempt]);

  const addTo = useCallback(
    async (selected: MapOverview | null) => {
      if (!subject) return;
      setBusy(true);
      setError(null);
      let createdMapId: string | null = null;
      try {
        let id = selected?.id ?? null;
        let editRevision = selected?.editRevision;
        if (id === null) {
          const created = await fetch("/api/maps", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "Untitled map" }),
          });
          if (!created.ok) throw new Error(await readApiError(created));
          const map = await created.json() as { id: string; editRevision: string };
          id = map.id;
          editRevision = map.editRevision;
          createdMapId = id;
        }
        let landed: { id: string };
        try {
          const layer = await fetch(`/api/maps/${id}/layers`, {
            method: "POST",
            headers: editRevision ? editHeaders({ editRevision }, { "content-type": "application/json" }) : { "content-type": "application/json" },
            body: JSON.stringify(landingRequest(subject, layerName)),
          });
          if (!layer.ok) throw new Error(await readApiError(layer));
          landed = (await layer.json()) as { id: string };
        } catch (landingError) {
          // A map minted for this landing must not survive ANY failure of
          // it — HTTP rejections, network errors, unparseable answers all
          // land here — else retries strand an
          // Untitled map per attempt. Best-effort, logged: the client
          // cannot do more than ask.
          if (createdMapId) {
            try {
              const gone = await fetch(`/api/maps/${createdMapId}`, {
                method: "DELETE",
                headers: editRevision ? editHeaders({ editRevision }) : undefined,
              });
              if (!gone.ok) throw new Error(`HTTP ${gone.status}`);
            } catch (cleanupError) {
              console.warn(
                `orphan-map cleanup failed for ${createdMapId}:`,
                cleanupError,
              );
            }
          }
          throw landingError;
        }
        // The builder opens with the landed layer selected (decision 2).
        router.push(`/maps/${id}?layer=${landed.id}`);
      } catch (e) {
        setError({
          message:
            e instanceof Error ? e.message : "The layer couldn't be added.",
          retryable: false,
        });
        setBusy(false);
      }
    },
    [subject, layerName, router],
  );

  if (!open) return null;

  return (
    <Dialog
      label={`Add ${subject?.label} to a map`}
      onClose={onClose}
      className={styles.dialog}
    >
      <div className={styles.head}>
        <strong>Add to a map</strong>
        <small>{subject?.label} becomes a layer on the map you pick</small>
      </div>

      {error && (
        <ErrorNote
          message={error.message}
          onRetry={
            error.retryable
              ? () => {
                  // Leave the failed state the moment the retry starts —
                  // the loading note takes over.
                  setError(null);
                  setAttempt((n) => n + 1);
                }
              : undefined
          }
          onDismiss={error.retryable ? undefined : () => setError(null)}
        />
      )}

      <label className={styles.nameField}>
        <span>Layer name</span>
        <input
          value={layerName}
          spellCheck={false}
          disabled={busy}
          onChange={(e) => setLayerName(e.target.value)}
        />
      </label>

      <div className={styles.list}>
        <div className={styles.grid}>
          <button
            className={styles.newCard}
            disabled={busy}
            onClick={() => void addTo(null)}
          >
            <span className={styles.newBadge}>
              <PlusIcon />
            </span>
            <b>New map</b>
            <small>Start a blank map with this layer</small>
          </button>
          {maps?.map((m) => (
            <button
              key={m.id}
              className={styles.card}
              disabled={busy}
              onClick={() => void addTo(m)}
            >
              <span className={`${gallery.strip} ${styles.strip}`}>
                <MapStrip map={m} />
              </span>
              <span className={styles.cardBody}>
                <b>{m.name}</b>
                <small>
                  <span className={styles.metaVal}>{m.layerCount}</span> layer
                  {m.layerCount === 1 ? "" : "s"} · edited{" "}
                  <span className={styles.metaVal}>
                    {formatRelativeTime(m.updatedAt)}
                  </span>
                </small>
                <StatusDot
                  className={styles.stateDot}
                  state={m.published ? "Published" : "Draft"}
                  tone={m.published ? "live" : "quiet"}
                />
              </span>
            </button>
          ))}
        </div>
        {maps === null && !error && (
          <p className={styles.note}>Reading maps…</p>
        )}
        {maps && maps.length === 0 && (
          <p className={styles.note}>
            No maps yet. The new map above starts one.
          </p>
        )}
      </div>

      <div className={styles.foot}>
        <Button variant="quiet" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        {busy && (
          <StatusLine className={styles.note}>Adding layer…</StatusLine>
        )}
      </div>
    </Dialog>
  );
}
