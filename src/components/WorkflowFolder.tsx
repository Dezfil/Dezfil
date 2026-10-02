"use client";

import type { KeyboardEvent, ReactNode } from "react";
import { formatBytes, formatCount, formatRelativeTime } from "./api";
import type { DataFolder } from "./data-folders";
import { IconOpen } from "./gallery-icons";
import { escapeBelongsToMenu } from "./menu-escape";
import { OwnerPill } from "./sharing/PeopleMarks";
import type { PersonLabel } from "./sharing/people";
import { SOURCE_COLORS } from "./table-chips";
import { WorkflowStatusChip } from "./WorkflowStatusChip";
import gallery from "./gallery.module.css";
import styles from "./WorkflowFolder.module.css";

/**
 * A workflow as one card among the tables: its name, its outputs' count
 * and size in the strip's reading, its newest output's time, the
 * Workflow chip in the operation colour and the Workflows list's state
 * chip; it opens without navigating, and *Open workflow* on the card,
 * the pane and the row goes to the canvas. The pane and the nested rows
 * render the page's own table cards and rows, handed in by the screen.
 */

const WORKFLOW_GLYPH = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.5" />
    <rect x="14" y="14" width="6.5" height="6.5" rx="1.5" />
    <path d="M10 6.75h4.75a2 2 0 0 1 2 2V14M14 17.25H9.25a2 2 0 0 1-2-2V10" />
  </svg>
);

const CHEVRON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="m9 6 6 6-6 6" />
  </svg>
);

const CROSS = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

/** The reference's motif: the workflow's nodes as a small chain, in the
 * operation colour; never a data render. */
function WorkflowMotif({ nodes }: { nodes: number }) {
  const n = Math.max(2, Math.min(6, nodes));
  const x0 = 40;
  const step = (240 - x0) / (n - 1);
  const parts: ReactNode[] = [];
  for (let i = 0; i < n; i++) {
    const x = x0 + i * step;
    const y = i % 2 ? 44 : 24;
    if (i < n - 1) {
      const x2 = x0 + (i + 1) * step;
      const y2 = (i + 1) % 2 ? 44 : 24;
      parts.push(
        <path
          key={`l${i}`}
          d={`M${x + 9} ${y} C ${x + step / 2} ${y}, ${x2 - step / 2} ${y2}, ${x2 - 9} ${y2}`}
          stroke="currentColor"
          strokeWidth="1.6"
          fill="none"
          opacity=".6"
        />,
      );
    }
    parts.push(<rect key={`n${i}`} x={x - 9} y={y - 9} width="18" height="18" rx="5" fill="currentColor" opacity={i % 2 ? 0.45 : 0.8} />);
  }
  return (
    <svg viewBox="0 0 280 92" preserveAspectRatio="xMidYMid slice" aria-hidden style={{ color: SOURCE_COLORS.operation }}>
      {parts}
    </svg>
  );
}

function outputsWord(n: number): string {
  return n === 1 ? "1 output" : `${n} outputs`;
}

/** The pane's element id, for the activator's aria-controls. */
export const paneId = (id: string) => `folder-pane-${id}`;

export interface FolderHandlers {
  onToggle: () => void;
  onClose: () => void;
  onOpenWorkflow: () => void;
}

function toggleKeys(e: KeyboardEvent, handlers: FolderHandlers, open: boolean) {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    handlers.onToggle();
  } else if (e.key === "Escape" && open) {
    e.preventDefault();
    handlers.onClose();
  }
}

export function FolderCard({
  folder,
  index,
  open,
  handlers,
  owner = null,
}: {
  folder: DataFolder;
  index: number;
  open: boolean;
  handlers: FolderHandlers;
  /** Someone else's workflow: its owner, marked in the corner as the
   * dataset cards beside it are. */
  owner?: PersonLabel | null;
}) {
  return (
    <article
      className={`${gallery.card} ${styles.folder}`}
      style={{ animationDelay: `${Math.min(index * 40, 320)}ms` }}
      data-folder-card={folder.id}
      data-open={open || undefined}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-controls={open ? paneId(folder.id) : undefined}
        aria-label={`${folder.name}, workflow, ${outputsWord(folder.outputs.length)}`}
        className={gallery.cardLink}
        onClick={handlers.onToggle}
        onKeyDown={(e) => toggleKeys(e, handlers, open)}
      >
        <div className={`${gallery.strip} ${styles.strip}`} style={{ height: 92 }}>
          <WorkflowMotif nodes={folder.workflow.summary.nodes} />
          <span className={gallery.overlayData}>
            <b>{folder.outputs.length}</b>{" "}
            <span className={gallery.cap}>
              {folder.outputs.length === 1 ? "output" : "outputs"} ·{" "}
              <span className={gallery.num}>{formatBytes(folder.bytes)}</span>
            </span>
          </span>
        </div>
        <div className={gallery.cardBody}>
          <div className={gallery.cardTop}>
            <span className={gallery.cardName}>{folder.name}</span>
            <span className={gallery.cardWhen}>{formatRelativeTime(folder.updatedAt)}</span>
          </div>
          <div className={gallery.cardChips}>
            <span className={gallery.chip} style={{ "--dot": SOURCE_COLORS.operation } as React.CSSProperties}>
              <i />
              Workflow
            </span>
            <WorkflowStatusChip summary={folder.workflow.summary} />
            <span className={`${gallery.chipGeo} ${styles.see}`} data-open={open || undefined}>
              {CHEVRON}
              {open ? "Close" : `See ${folder.outputs.length}`}
            </span>
          </div>
        </div>
      </div>
      {owner && <OwnerPill owner={owner} placement="corner" />}
      <span className={gallery.acts}>
        <button
          data-hint="Open workflow"
          aria-label={`Open workflow ${folder.name}`}
          data-open-workflow
          onClick={(e) => {
            e.stopPropagation();
            handlers.onOpenWorkflow();
          }}
        >
          <IconOpen />
        </button>
      </span>
    </article>
  );
}

/** The open folder's pane at the end of its row: the facts, Open
 * workflow, a close, and the outputs as the page's cards. */
export function FolderPane({
  folder,
  handlers,
  children,
}: {
  folder: DataFolder;
  handlers: FolderHandlers;
  children: ReactNode;
}) {
  return (
    <div
      id={paneId(folder.id)}
      className={styles.pane}
      data-folder-pane={folder.id}
      onKeyDown={(e) => {
        // An Escape pressed in a menu inside the pane (an output's export
        // menu, which focuses its items and closes on the document's
        // listener, after this one) is that menu's, not the folder's.
        if (e.key === "Escape" && !escapeBelongsToMenu(e)) {
          e.preventDefault();
          handlers.onClose();
        }
      }}
    >
      <div className={styles.paneHead}>
        <span className={styles.glyph}>{WORKFLOW_GLYPH}</span>
        <h2 className={styles.paneName}>{folder.name}</h2>
        <span className={styles.paneCount}>{outputsWord(folder.outputs.length)}</span>
        <WorkflowStatusChip summary={folder.workflow.summary} />
        <button type="button" className={styles.paneLink} data-open-workflow onClick={handlers.onOpenWorkflow}>
          Open workflow →
        </button>
        <button type="button" className={styles.paneClose} aria-label={`Close ${folder.name}`} data-folder-close onClick={handlers.onClose}>
          {CROSS}
        </button>
      </div>
      <div className={gallery.dataGrid}>{children}</div>
    </div>
  );
}

/** The folder's row in the list: the same facts in the shipped columns.
 * The disclosure button is the activator that carries the expanded
 * state; the row itself toggles on a click as a table's row opens on
 * one, so no control nests in another. */
export function FolderRow({
  folder,
  open,
  handlers,
  nameCellClass,
  withProjectCell,
  owner = null,
}: {
  folder: DataFolder;
  open: boolean;
  handlers: FolderHandlers;
  nameCellClass: string;
  /** Someone else's workflow: its owner, marked after the name. */
  owner?: PersonLabel | null;
  /** Column alignment only: a folder is a presentation
   * grouping and asserts no project membership. */
  withProjectCell?: boolean;
}) {
  const state = folder.workflow.summary;
  return (
    <tr
      className={styles.row}
      data-folder-row={folder.id}
      data-open={open || undefined}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        handlers.onToggle();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.preventDefault();
          handlers.onClose();
        }
      }}
    >
      <td className={`${nameCellClass} ${styles.rowName}`}>
        <button
          type="button"
          className={styles.disclose}
          aria-expanded={open}
          aria-label={`${folder.name}, workflow, ${outputsWord(folder.outputs.length)}`}
          data-folder-toggle
          onClick={handlers.onToggle}
        >
          {CHEVRON}
        </button>
        {folder.name}
        {owner && <OwnerPill owner={owner} placement="inline" />}
      </td>
      <td>
        <span className={gallery.chip} style={{ "--dot": SOURCE_COLORS.operation } as React.CSSProperties}>
          <i />
          Workflow
        </span>
      </td>
      <td className={styles.rowFacts}>
        {outputsWord(folder.outputs.length)}
        <span className={styles.rowState}>
          <WorkflowStatusChip summary={state} />
        </span>
      </td>
      <td className={gallery.numCell}>{formatCount(folder.rows)}</td>
      <td className={gallery.numCell}>{formatBytes(folder.bytes)}</td>
      {withProjectCell && <td aria-hidden />}
      <td className={gallery.numCell}>{formatRelativeTime(folder.updatedAt)}</td>
      <td>
        <span className={gallery.rowActs}>
          <button
            data-hint="Open workflow"
            aria-label={`Open workflow ${folder.name}`}
            data-open-workflow
            onClick={(e) => {
              e.stopPropagation();
              handlers.onOpenWorkflow();
            }}
          >
            <IconOpen />
          </button>
        </span>
      </td>
    </tr>
  );
}

/** The indent before a nested row's name. */
export function NestedIndent() {
  return <span className={styles.indent} aria-hidden />;
}
