"use client";

import type { ReactNode } from "react";
import { formatRelativeTime } from "../api";
import { IconData, IconMap, IconWorkflow } from "../gallery-icons";
import { ProjectPicture } from "./ProjectPicture";
import {
  EMPTY_WORD,
  cardCounts,
  isEmptyProject,
  type PictureItem,
  type ProjectOverview,
} from "./model";
import gallery from "../gallery.module.css";
import styles from "../ProjectsScreen.module.css";

/**
 * The Projects collection's presentation: a project's card and row over
 * its picture and the counts that drop zeros. The screen keeps the
 * state — the name cell that becomes an input, the three actions with
 * their arming — and hands them in; these only lay them out.
 */

const count = (n: number, word: string) =>
  `${n} ${word}${n === 1 ? "" : "s"}`;

const partialTitle = (p: ProjectOverview) =>
  p.sizeComplete ? undefined : "Partial: a member dataset's size is unknown";

function PublishedChip({ n }: { n: number }) {
  if (n === 0) return null;
  return (
    <span className={gallery.chip} data-live>
      <i />
      {n} published
    </span>
  );
}

/** The counts line: a kind only when the project has one, the size
 * only with a dataset; a project with nothing says so. */
function CountsRow({
  project: p,
  workflowCount,
}: {
  project: ProjectOverview;
  workflowCount: number;
}) {
  if (isEmptyProject(p, workflowCount)) {
    return (
      <div className={styles.counts} data-counts>
        <span className={styles.nothing} data-count="empty">
          {EMPTY_WORD}
        </span>
      </div>
    );
  }
  const c = cardCounts(p, workflowCount);
  return (
    <div className={styles.counts} data-counts>
      {c.maps !== null && (
        <span data-count="maps">
          <IconMap />
          {c.maps}
        </span>
      )}
      {c.workflows !== null && (
        <span data-count="workflows">
          <IconWorkflow />
          {c.workflows}
        </span>
      )}
      {c.datasets !== null && (
        <span data-count="datasets">
          <IconData />
          {c.datasets}
        </span>
      )}
      {c.size !== null && (
        <span data-count="size" title={partialTitle(p)}>
          {c.size}
        </span>
      )}
    </div>
  );
}

/** The list's Contents column: each non-zero kind with its word. */
function ContentsCell({
  project: p,
  workflowCount,
}: {
  project: ProjectOverview;
  workflowCount: number;
}) {
  if (isEmptyProject(p, workflowCount)) {
    return <span className={styles.nothing}>{EMPTY_WORD}</span>;
  }
  return (
    <>
      {p.mapCount > 0 && (
        <span>
          <IconMap />
          {count(p.mapCount, "map")}
        </span>
      )}
      {workflowCount > 0 && (
        <span>
          <IconWorkflow />
          {count(workflowCount, "workflow")}
        </span>
      )}
      {p.tableCount > 0 && (
        <span>
          <IconData />
          {count(p.tableCount, "dataset")}
        </span>
      )}
    </>
  );
}

interface Shared {
  project: ProjectOverview;
  /** The people chip beside the published chip, when the project is
   * shared one way or the other. */
  mark?: ReactNode;
  picture: PictureItem[];
  workflowCount: number;
  groupOf: (operation: string) => string | null;
  /** The name, or the rename input while editing. */
  nameCell: ReactNode;
  /** The three actions: rename, export, the two-press delete. */
  acts: ReactNode;
  onOpen: () => void;
}

export function ProjectCard({
  project: p,
  mark,
  picture,
  workflowCount,
  groupOf,
  nameCell,
  acts,
  onOpen,
  delay,
}: Shared & { delay: number }) {
  return (
    <article
      className={gallery.card}
      style={{ animationDelay: `${delay}ms` }}
    >
      <div
        role="link"
        tabIndex={0}
        aria-label={`Open ${p.name}`}
        className={gallery.cardLink}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter") onOpen();
        }}
      >
        <div
          className={`${gallery.strip} ${styles.picStrip}`}
          style={{ height: 148 }}
        >
          <ProjectPicture items={picture} size="card" groupOf={groupOf} />
        </div>
        <div className={gallery.cardBody}>
          <div className={gallery.cardTop}>
            {nameCell}
            <span className={gallery.cardWhen}>
              {formatRelativeTime(p.updatedAt)}
            </span>
          </div>
          <CountsRow project={p} workflowCount={workflowCount} />
          {p.note && (
            <div className={styles.note} data-note>
              {p.note}
            </div>
          )}
          {(p.publishedMapCount > 0 || mark) && (
            <div className={gallery.cardChips}>
              <PublishedChip n={p.publishedMapCount} />
              {mark}
            </div>
          )}
        </div>
      </div>
      <div className={gallery.acts}>{acts}</div>
    </article>
  );
}

export function ProjectsListHead() {
  return (
    <div className={gallery.listHead}>
      <span className={gallery.colThumb} />
      <span className={gallery.colName}>Name</span>
      <span className={styles.colCounts}>Contents</span>
      <span className={styles.colPub}>Status</span>
      <span className={gallery.colMeta}>Size</span>
      <span className={gallery.colWhen}>Updated</span>
      <span className={gallery.colActs} />
    </div>
  );
}

export function ProjectRow({
  project: p,
  mark,
  picture,
  workflowCount,
  groupOf,
  nameCell,
  acts,
  onOpen,
}: Shared) {
  return (
    <div className={styles.listRowWrap}>
      <button
        className={gallery.listRow}
        onClick={onOpen}
        aria-label={`Open ${p.name}`}
      >
        <span className={gallery.colThumb}>
          <span className={styles.rowMosaic}>
            <ProjectPicture items={picture} size="row" groupOf={groupOf} />
          </span>
        </span>
        <span className={gallery.colName}>
          <span className={gallery.rowName} data-row-name>
            {nameCell}
          </span>
        </span>
        <span className={styles.colCounts} data-row-contents>
          <ContentsCell project={p} workflowCount={workflowCount} />
        </span>
        <span className={styles.colPub}>
          <PublishedChip n={p.publishedMapCount} />
          {mark}
        </span>
        <span
          className={gallery.colMeta}
          title={partialTitle(p)}
          data-size-cell
        >
          {p.tableCount > 0 ? cardCounts(p, 0).size : ""}
        </span>
        <span className={gallery.colWhen}>
          {formatRelativeTime(p.updatedAt)}
        </span>
        <span className={gallery.colActs} />
      </button>
      <span className={styles.listRowActs}>{acts}</span>
    </div>
  );
}
