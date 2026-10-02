"use client";

import type { ReactNode } from "react";
import {
  formatBytes,
  formatCompactCount,
  formatCount,
  formatRelativeTime,
  type TableListing,
} from "./api";
import { ExportMenu } from "./ExportMenu";
import {
  DataMotif,
  geometryFamilies,
  IconAddToMap,
  IconFolderPlus,
  IconSql,
  IconTrash,
} from "./gallery-icons";
import {
  CrsChip,
  GeometryChip,
  HEADER_SUSPECT_TITLE,
  HeaderChip,
  SourceChip,
} from "./table-chips";
import { updatedAt } from "./data-folders";
import { escapeBelongsToMenu } from "./menu-escape";
import { OwnerPill } from "./sharing/PeopleMarks";
import type { PersonLabel } from "./sharing/people";
import gallery from "./gallery.module.css";
import styles from "./TablesScreen.module.css";

/**
 * The Data page's table card and table row with their quick actions,
 * extracted from the screen so a workflow folder's pane and nested rows
 * render the same components the page does. Behaviour-preserving: the
 * markup is the screen's own.
 */

export interface TableActionsProps {
  table: TableListing;
  /** The delete button's two-press confirmation, owned by the screen. */
  confirming: boolean;
  deleting: boolean;
  onOpen: () => void;
  onQuery: () => void;
  onAddToMap: () => void;
  /** Filing: the add-to-project dialog over this
   * dataset — on loose and nested rows alike, never on a folder's. */
  onFile: () => void;
  onDeletePress: () => void;
  onDeleteBlur: () => void;
}

export function TableActions({
  table: t,
  confirming,
  deleting,
  onQuery,
  onAddToMap,
  onFile,
  onDeletePress,
  onDeleteBlur,
  rowStyle,
  mine = true,
}: TableActionsProps & {
  rowStyle: string;
  /** False on someone else's dataset: filing and deleting stay theirs. */
  mine?: boolean;
}) {
  return (
    <span className={rowStyle}>
      {mine && (
        <button
          data-hint="Add to a project"
          aria-label={`Add to a project: ${t.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onFile();
          }}
        >
          <IconFolderPlus />
        </button>
      )}
      <button
        data-hint="Query in SQL"
        aria-label={`Query ${t.name} in SQL`}
        onClick={(e) => {
          e.stopPropagation();
          onQuery();
        }}
      >
        <IconSql />
      </button>
      {t.geometryColumn && (
        <button
          data-hint="Add to a map"
          aria-label={`Add ${t.name} to a map`}
          onClick={(e) => {
            e.stopPropagation();
            onAddToMap();
          }}
        >
          <IconAddToMap />
        </button>
      )}
      <ExportMenu name={t.name} dataset={t} spatial={!!t.geometryColumn} />
      {mine && (
        <button
          className={gallery.deleteAct}
          data-confirm={confirming || undefined}
          disabled={deleting}
          data-hint={
            confirming
              ? "Click again to delete permanently"
              : "Delete this table and its data"
          }
          aria-label={
            confirming ? `Confirm deleting ${t.name}` : `Delete ${t.name}`
          }
          onClick={(e) => {
            e.stopPropagation();
            onDeletePress();
          }}
          onBlur={onDeleteBlur}
        >
          {confirming ? "Delete?" : <IconTrash />}
        </button>
      )}
    </span>
  );
}

/** A table's card in the grid: the strip's motif and reading, the name
 * and time, the chips, the quick actions on hover. */
export function TableCard({
  table: t,
  index,
  actions,
  owner = null,
}: {
  table: TableListing;
  /** Position in its grid, for the entrance stagger. */
  index: number;
  actions: TableActionsProps;
  /** Someone else's dataset: its owner, marked in the corner. */
  owner?: PersonLabel | null;
}) {
  return (
    <article
      className={gallery.card}
      style={{ animationDelay: `${Math.min(index * 40, 320)}ms` }}
      data-table-card={t.name}
    >
      <div
        role="link"
        tabIndex={0}
        aria-label={`Open ${t.name}`}
        className={gallery.cardLink}
        onClick={actions.onOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter") actions.onOpen();
        }}
      >
        <div className={gallery.strip} style={{ height: 92 }}>
          <DataMotif
            kinds={geometryFamilies(t.geometryType, t.geometryColumn)}
          />
          <span className={gallery.overlayData}>
            <b>{formatCompactCount(t.rowCount)}</b>{" "}
            <span className={gallery.cap}>
              rows ·{" "}
              <span className={gallery.num}>{formatBytes(t.sizeBytes)}</span>
            </span>
          </span>
        </div>
        <div className={gallery.cardBody}>
          <div className={gallery.cardTop}>
            {/* The card name reads in the UI face with the rest of
                the card — mono stays in the list view's table (a field round). */}
            <span className={gallery.cardName}>{t.name}</span>
            <span className={gallery.cardWhen}>
              {formatRelativeTime(updatedAt(t))}
            </span>
          </div>
          <div className={gallery.cardChips}>
            <SourceChip table={t} />
            <GeometryChip table={t} />
            <CrsChip table={t} />
            <HeaderChip table={t} />
          </div>
        </div>
      </div>
      {owner && <OwnerPill owner={owner} placement="corner" />}
      <TableActions {...actions} rowStyle={gallery.acts} mine={!owner} />
    </article>
  );
}

/** A table's row in the list view, with the same actions. */
export function TableRow({
  table: t,
  actions,
  nested,
  leading,
  className,
  onEscape,
  projectFact,
  owner = null,
}: {
  table: TableListing;
  actions: TableActionsProps;
  /** Inside an unfolded workflow folder. */
  nested?: boolean;
  /** Anything before the name in its cell (the folder's indent). */
  leading?: ReactNode;
  className?: string;
  /** Escape with focus on the row: an unfolded row closes its folder. */
  onEscape?: () => void;
  /** The Project column's fact: text, never a control. */
  projectFact?: { text: string; none: boolean };
  /** Someone else's dataset: its owner, marked after the name. */
  owner?: PersonLabel | null;
}) {
  const geometry =
    t.geometryColumn === null ? "—" : t.geometryType || "Geometry";
  return (
    <tr
      tabIndex={0}
      className={className}
      data-table-row={t.name}
      data-nested={nested || undefined}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        actions.onOpen();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !(e.target as HTMLElement).closest("button"))
          actions.onOpen();
        if (e.key === "Escape" && onEscape && !escapeBelongsToMenu(e)) {
          e.preventDefault();
          onEscape();
        }
      }}
    >
      <td className={styles.nameCell}>
        {leading}
        {t.name}
        {owner && <OwnerPill owner={owner} placement="inline" />}
      </td>
      <td>
        <SourceChip table={t} />
      </td>
      <td className={gallery.geomCell}>
        {geometry}
        {t.crsAssumed && (
          <span
            className={gallery.warnNote}
            title="The file declared no CRS; WGS84 was assumed"
          >
            {" "}
            · WGS84 assumed
          </span>
        )}
        {t.headerSuspect && (
          <span className={gallery.warnNote} title={HEADER_SUSPECT_TITLE}>
            {" "}
            · Header looks broken
          </span>
        )}
      </td>
      <td className={gallery.numCell}>{formatCount(t.rowCount)}</td>
      <td className={gallery.numCell}>{formatBytes(t.sizeBytes)}</td>
      {projectFact && (
        <td
          className={gallery.projCell}
          data-none={projectFact.none || undefined}
        >
          {projectFact.text}
        </td>
      )}
      <td className={gallery.numCell}>{formatRelativeTime(updatedAt(t))}</td>
      <td>
        <TableActions {...actions} rowStyle={gallery.rowActs} mine={!owner} />
      </td>
    </tr>
  );
}
