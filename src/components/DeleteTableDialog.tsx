"use client";

import { useEffect, useRef, useState } from "react";
import type { TableReader, TableReaders } from "@/lib/table-readers";
import { formatCount, readApiError } from "./api";
import { serverUnreachable } from "./failure-copy";
import { IconMap, IconWorkflow } from "./gallery-icons";
import gallery from "./gallery.module.css";
import home from "./projects/ProjectHome.module.css";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { ErrorNote } from "./ui/ErrorNote";
import styles from "./DeleteTableDialog.module.css";

/** The table a delete was opened for, as its opener knew it. */
export type DeletableTable = { id: string; name: string; rowCount: number };

/** What reads the table, as far as the check has got. An answer carries the
 * table it is for, so one that arrives for another table never shows. */
type Check =
  | { for: string; state: "answered"; readers: TableReader[]; unlisted: number }
  | { for: string; state: "failed" };

/**
 * Deleting a table, after saying what reads it.
 *
 * The opener passes the table's identifier, name and row count, so the
 * opening sentence stands even when the check fails. The check and the
 * delete both address the table by that identifier: a table replaced by a
 * new one of the same name is gone for this dialog, never swapped for the
 * newcomer. Each opening is its own request, aborted when the dialog closes.
 *
 * A check that fails leaves Delete table available: the owner can still
 * decide, and the dialog never shows a partial list as if it were whole.
 */
export function DeleteTableDialog({
  table,
  onClose,
  onDeleted,
}: {
  table: DeletableTable;
  onClose: () => void;
  /** The table is gone; the opener does what follows a delete. */
  onDeleted: () => void;
}) {
  const { id } = table;
  const [check, setCheck] = useState<Check | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    readReaders(id, controller.signal).then(
      (answer) => setCheck({ for: id, state: "answered", readers: answer.readers, unlisted: answer.unlisted }),
      () => {
        if (!controller.signal.aborted) setCheck({ for: id, state: "failed" });
      },
    );
    return () => controller.abort();
  }, [id]);

  const current = check?.for === id ? check : null;

  const remove = async () => {
    if (inFlight.current || !current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/tables/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await readApiError(response));
    } catch (cause) {
      inFlight.current = false;
      setBusy(false);
      setError(cause instanceof TypeError ? serverUnreachable("delete the table") : cause instanceof Error ? cause.message : "The table couldn't be deleted.");
      return;
    }
    // Still in flight until the opener moves on: the dialog may outlive the
    // delete by a navigation, and a second press must not send another.
    onDeleted();
  };

  return (
    <Dialog
      label={`Delete ${table.name}`}
      className={styles.dialog}
      data-delete-table={id}
      onClose={() => {
        if (!inFlight.current) onClose();
      }}
    >
      <div className={home.dialogHead}>
        <strong>Delete {table.name}?</strong>
      </div>
      <div className={styles.body}>
        <p>
          This deletes the table and its {rowsPhrase(table.rowCount)}.
          {current?.state === "answered" && current.readers.length > 0 && " These read from it and will stop working:"}
          {current?.state === "answered" && current.readers.length === 0 && current.unlisted === 0 && " No map layer or workflow step reads from it."}
        </p>
        {!current && <p role="status">Checking what reads it…</p>}
        {current?.state === "failed" && <ErrorNote tone="warn" message="Couldn't check what reads this table." />}
        {current?.state === "answered" && <Readers readers={current.readers} unlisted={current.unlisted} />}
        {error && <ErrorNote message={error} />}
      </div>
      <div className={home.dialogFoot}>
        <Button variant="quiet" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button variant="danger" disabled={!current} busy={busy} onClick={() => void remove()}>
          Delete table
        </Button>
      </div>
    </Dialog>
  );
}

function Readers({ readers, unlisted }: { readers: TableReader[]; unlisted: number }) {
  const published = readers.some((reader) => reader.kind === "layer" && reader.map.published);
  return (
    <>
      {readers.length > 0 && (
        <ul className={styles.readers} data-table-readers>
          {readers.map((reader) => (
            <li key={reader.kind === "layer" ? reader.layer.id : reader.step.id} className={styles.reader}>
              <span className={styles.icon} aria-hidden="true">
                {reader.kind === "layer" ? <IconMap /> : <IconWorkflow />}
              </span>
              <span className={styles.text}>
                <span className={styles.name}>{reader.kind === "layer" ? reader.map.name : reader.workflow.name}</span>
                <span className={styles.what}>
                  {reader.kind === "layer"
                    ? `Layer “${reader.layer.name}”`
                    : `Step ${reader.step.position} · ${reader.step.label}`}
                </span>
              </span>
              {reader.kind === "layer" && reader.map.published && (
                <span className={gallery.chip} data-live>
                  <i />
                  Published
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {unlisted > 0 && <p>And {formatCount(unlisted)} more in maps or workflows you can&apos;t open.</p>}
      {published && <p className={styles.consequence}>Published maps in this list can break for their readers.</p>}
    </>
  );
}

function rowsPhrase(count: number): string {
  return count === 1 ? "1 row" : `${formatCount(count)} rows`;
}

async function readReaders(id: string, signal: AbortSignal): Promise<TableReaders> {
  const response = await fetch(`/api/tables/${encodeURIComponent(id)}/readers`, { signal });
  if (!response.ok) throw new Error(await readApiError(response));
  const answer = (await response.json()) as TableReaders;
  if (answer.table?.id !== id) throw new Error("The answer is for another table.");
  return answer;
}
