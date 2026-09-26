"use client";

import { useState } from "react";
import { formatCount } from "../api";
import { GeometryIcon, geometryKind } from "../gallery-icons";
import { IconButton } from "../ui/IconButton";
import { CheckIcon, PlayIcon, XIcon } from "../ui/icons";
import { SqlExcerpt } from "./SqlExcerpt";
import {
  groupByDay,
  isLong,
  timeOf,
  titleOf,
  type HistoryEntry,
} from "./sql-history";
import styles from "./SqlConsole.module.css";

/**
 * The History tab: cards newest first, grouped by day — a ran/failed
 * mark, the recognized tables as the title, the SQL as a clamped excerpt
 * with Show all, the time, rows and duration or the failure code; Load
 * (the card), Run again and Remove on hover and by keyboard; Clear
 * history at the foot.
 */
export function HistoryList({
  entries,
  geometryOf,
  onLoad,
  onRun,
  onRemove,
  onClear,
}: {
  entries: readonly HistoryEntry[];
  geometryOf: (table: string) =>
    | { geometryType: string | null; geometryColumn: string | null }
    | undefined;
  onLoad: (sql: string) => void;
  onRun: (sql: string) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  if (!entries.length) {
    return (
      <p className={styles.historyEmpty}>
        Nothing run yet. Every run lands here, newest first.
      </p>
    );
  }
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <div className={styles.history}>
      {groupByDay(entries).map((group) => (
        <div key={group.label} className={styles.historyGroup}>
          <p className={styles.groupEyebrow}>{group.label}</p>
          {group.entries.map((h) => {
            const long = isLong(h.sql);
            const isOpen = open.has(h.id);
            const first = h.tables[0];
            const geometry = first ? geometryOf(first) : undefined;
            return (
              <div
                key={h.id}
                role="button"
                tabIndex={0}
                className={styles.card}
                data-history-card
                data-failed={!h.ok || undefined}
                data-open={isOpen || undefined}
                onClick={() => onLoad(h.sql)}
                onKeyDown={(e) => {
                  // The card's own key, never a nested action's.
                  if (e.target !== e.currentTarget) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onLoad(h.sql);
                  }
                }}
              >
                <div className={styles.cardTop}>
                  <span
                    className={styles.cardStatus}
                    aria-label={h.ok ? "ran" : "failed"}
                  >
                    {h.ok ? <CheckIcon /> : <XIcon />}
                  </span>
                  {geometry !== undefined && (
                    <span className={styles.rowGlyph} data-kind={geometryKind(geometry.geometryType, geometry.geometryColumn)}>
                      <GeometryIcon kind={geometryKind(geometry.geometryType, geometry.geometryColumn)} />
                    </span>
                  )}
                  <span className={styles.cardTitle}>{titleOf(h)}</span>
                  <span className={styles.cardWhen}>{timeOf(h.at)}</span>
                </div>
                <SqlExcerpt sql={h.sql.trim()} clamped={!isOpen} />
                <div className={styles.cardMeta}>
                  {h.ok ? (
                    <>
                      <span>{formatCount(h.rows)} rows</span>
                      <span>{h.ms} ms</span>
                    </>
                  ) : (
                    <span className={styles.cardFailed}>failed · {h.code}</span>
                  )}
                  {long && (
                    <button
                      type="button"
                      className={styles.linkBtn}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle(h.id);
                      }}
                    >
                      {isOpen ? "Show less" : "Show all"}
                    </button>
                  )}
                  <span className={styles.cardActs}>
                    <IconButton
                      className={styles.rowAct}
                      action="Run again"
                      icon={<PlayIcon />}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRun(h.sql);
                      }}
                    />
                    <IconButton
                      className={styles.rowAct}
                      action="Remove from history"
                      icon={<XIcon />}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemove(h.id);
                      }}
                    />
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      ))}
      <div className={styles.historyFoot}>
        <button type="button" className={styles.ghostBtn} onClick={onClear}>
          Clear history
        </button>
      </div>
    </div>
  );
}
