"use client";

import { useRouter } from "next/navigation";
import { LastChanged } from "../sharing/LastChanged";
import { formatRelativeTime } from "../api";
import { DataMotif, geometryFamilies } from "../gallery-icons";
import { MapStrip } from "../MapStrip";
import { Button } from "../ui/Button";
import { MoveIcon, PlusIcon } from "../ui/icons";
import { WorkflowThumb } from "../WorkflowThumb";
import { OwnerPill } from "../sharing/PeopleMarks";
import { datasetPageHref } from "../dataset-doors";
import { KindIcon } from "./ProjectPicture";
import { KIND_WORD, whereLine, type RecentItem } from "./recent-model";
import gallery from "../gallery.module.css";
import styles from "./RecentList.module.css";

/**
 * The recent card and its rows, as the empty project draws them: the list
 * card under its heading, and per item the kind first, the picture, the
 * name with the owner's pill on someone else's, where it lives, one fact,
 * and who changed it when (the time alone for a dataset). A row comes in
 * two forms: filing, with Add or Move on one's own work, as the empty
 * project offers; and opening, where the row is the link to its item and
 * files nothing. Presentation only: the host owns the reads.
 */

/** What a row offers. */
export type RecentRowForm =
  | {
      kind: "filing";
      /** The row whose Add is in flight, if any. */
      busyId: string | null;
      onAdd: (item: RecentItem) => void;
    }
  | { kind: "opening" };

/** The list card under its heading, with a hint beside the heading. */
export function RecentCard({
  heading,
  hint,
  children,
}: {
  heading: string;
  hint?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className={`${gallery.listCard} ${styles.recentCard}`} data-recent>
      <div className={`${gallery.listHead} ${styles.recentHead}`}>
        <span data-recent-heading>{heading}</span>
        {hint && <i data-recent-hint>{hint}</i>}
      </div>
      {children}
    </div>
  );
}

/** A line in the card for its state: loading, a failure, or nothing to
 * list (`none`). */
export function RecentStateRow({
  none = false,
  children,
}: {
  none?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.stateRow} data-recent-none={none || undefined}>
      {children}
    </div>
  );
}

/** Where an item's row opens. */
export function recentHref(it: RecentItem): string {
  if (it.kind === "map") return `/maps/${it.id}`;
  if (it.kind === "workflow") return `/workflows/${it.id}`;
  return datasetPageHref(it.table);
}

export function RecentRow({
  item,
  groupOf,
  form,
}: {
  item: RecentItem;
  groupOf: (operation: string) => string | null;
  form: RecentRowForm;
}) {
  return form.kind === "opening" ? (
    <OpeningRow item={item} groupOf={groupOf} />
  ) : (
    <FilingRow item={item} groupOf={groupOf} busyId={form.busyId} onAdd={form.onAdd} />
  );
}

/** The row's kind, picture, name and line, in either form. */
function RowContent({
  item: it,
  groupOf,
}: {
  item: RecentItem;
  groupOf: (operation: string) => string | null;
}) {
  return (
    <>
      <span className={styles.kindTile} aria-hidden>
        <KindIcon kind={it.kind} />
      </span>
      <span className={styles.kindWord} data-recent-kind>
        {KIND_WORD[it.kind]}
      </span>
      <span className={styles.pic}>
        {it.kind === "map" ? (
          <MapStrip map={it.map} />
        ) : it.kind === "workflow" ? (
          <WorkflowThumb steps={it.workflow.steps} groupOf={groupOf} compact />
        ) : (
          <DataMotif
            kinds={geometryFamilies(it.table.geometryType, it.table.geometryColumn)}
          />
        )}
      </span>
      <span className={styles.text}>
        <span className={styles.nameLine}>
          <b className={it.kind === "dataset" ? styles.mono : undefined} data-recent-name>
            {it.name}
          </b>
          {it.owner && <OwnerPill owner={it.owner} placement="inline" />}
        </span>
        <small data-recent-meta>
          <span data-recent-where>{whereLine(it.where)}</span>
          <i>·</i>
          {it.fact}
          <i>·</i>
          {it.kind === "dataset" ? formatRelativeTime(it.time) : <LastChanged value={it.kind === "map" ? it.map : it.workflow} />}
        </small>
      </span>
    </>
  );
}

function FilingRow({
  item: it,
  groupOf,
  busyId,
  onAdd,
}: {
  item: RecentItem;
  groupOf: (operation: string) => string | null;
  busyId: string | null;
  onAdd: (item: RecentItem) => void;
}) {
  // A map or workflow filed elsewhere leaves that project when it
  // comes here (at most one project): the button says so; a
  // dataset, or anything unfiled, is added.
  const moves = it.kind !== "dataset" && it.where.length > 0;
  return (
    <div className={styles.row} data-recent-row={it.kind}>
      <RowContent item={it} groupOf={groupOf} />
      {!it.owner && (
        <Button
          className={styles.add}
          aria-label={`${moves ? "Move" : "Add"} ${it.name}`}
          busy={busyId === it.id}
          disabled={busyId !== null}
          onClick={() => onAdd(it)}
          data-recent-action={moves ? "move" : "add"}
        >
          {moves ? <MoveIcon /> : <PlusIcon />} {moves ? "Move" : "Add"}
        </Button>
      )}
    </div>
  );
}

/** The row as the link to its item: named by the item, with the owner's
 * name after it on someone else's; Enter opens, as on a card. */
function OpeningRow({
  item: it,
  groupOf,
}: {
  item: RecentItem;
  groupOf: (operation: string) => string | null;
}) {
  const router = useRouter();
  const href = recentHref(it);
  return (
    <div
      role="link"
      tabIndex={0}
      aria-label={it.owner ? `${it.name}, ${it.owner.name}` : it.name}
      className={`${styles.row} ${styles.opens}`}
      data-recent-row={it.kind}
      onClick={() => router.push(href)}
      onKeyDown={(e) => {
        if (e.key === "Enter") router.push(href);
      }}
    >
      <RowContent item={it} groupOf={groupOf} />
    </div>
  );
}
