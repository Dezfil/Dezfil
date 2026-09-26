"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/Button";
import { CopyIcon } from "../ui/icons";
import { formatCell, fullValue } from "./result-format";
import styles from "./SqlConsole.module.css";

/**
 * The console's result table: a sticky-header grid of the preview rows with
 * row numbers, a footer naming the cap and the total when the result is
 * cut, and a cell peek — click a cell to read the whole value and copy it.
 * The builder's shared grid stays untouched.
 */
export interface ResultColumn {
  name: string;
  type: string;
}

export function ResultTable({
  columns,
  rows,
  geometryColumn,
  footer,
  emptyText = "The query ran and returned zero rows.",
}: {
  columns: readonly ResultColumn[];
  rows: readonly Record<string, unknown>[];
  geometryColumn: string | null;
  /** The truncation footer's sentence, or null when nothing was cut. */
  footer: string | null;
  /** The zero-row sentence: the console's query wording unless the host
   * says otherwise (the results band shows a dataset, not a query). */
  emptyText?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const copyRef = useRef<HTMLButtonElement>(null);
  // The cell that opened the peek: focus returns to it when the peek closes.
  const openerRef = useRef<HTMLElement | null>(null);
  const [peek, setPeek] = useState<{
    value: string;
    left: number;
    top: number;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!peek) return;
    const close = (e: MouseEvent) => {
      const host = hostRef.current;
      if (!host) return;
      const target = e.target as Node;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest(`.${styles.peek}`) || target.closest("td")) return;
      setPeek(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [peek]);

  // The peek is operable by keyboard: Copy takes focus
  // when the peek opens; Escape on the peek closes it and returns focus to
  // the cell (handled on the peek itself, so a host's own Escape — the
  // canvas clears its selection on it — never sees the key).
  useEffect(() => {
    if (!peek) return;
    copyRef.current?.focus();
  }, [peek]);
  const closePeek = () => {
    setPeek(null);
    openerRef.current?.focus();
  };

  const openPeek = (cell: HTMLElement, value: unknown) => {
    const host = hostRef.current;
    if (!host) return;
    const hr = host.getBoundingClientRect();
    const tr = cell.getBoundingClientRect();
    openerRef.current = cell;
    setCopied(false);
    setPeek({
      value: fullValue(value),
      left: Math.max(0, Math.min(tr.left - hr.left, hr.width - 380)),
      top: tr.bottom - hr.top + 4,
    });
  };

  if (rows.length === 0) {
    return (
      <div className={styles.resEmpty}>
        <div className={styles.resEmptyBig}>{emptyText}</div>
      </div>
    );
  }

  return (
    <div ref={hostRef} className={styles.tableHost}>
      <div className={styles.gridWrap} data-foot={footer ? "" : undefined}>
        <table className={styles.grid}>
          <thead>
            <tr>
              <th className={styles.rn} aria-label="Row" />
              {columns.map((c) => (
                <th key={c.name} data-geom={c.name === geometryColumn || undefined}>
                  {c.name}
                  <span className={styles.thType}>{c.type}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                <td className={styles.rn}>{i + 1}</td>
                {columns.map((c) => {
                  const f = formatCell(row[c.name]);
                  return (
                    <td
                      key={c.name}
                      data-kind={f.kind}
                      title={f.kind === "geometry" || f.text.length > 40 ? "Click to read the whole value" : undefined}
                      // A cell is reached and revealed by keyboard as by
                      // pointer: Enter or Space opens the
                      // peek, whose Copy is a button of its own.
                      tabIndex={0}
                      onClick={(e) => openPeek(e.currentTarget, row[c.name])}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          openPeek(e.currentTarget, row[c.name]);
                        }
                      }}
                    >
                      {f.text.length > 120 ? f.text.slice(0, 120) + "…" : f.text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {footer && <div className={styles.gridFoot}>{footer}</div>}
      {peek && (
        <div
          className={styles.peek}
          style={{ left: peek.left, top: peek.top }}
          role="dialog"
          aria-label="Cell value"
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            e.stopPropagation();
            closePeek();
          }}
        >
          <pre className={styles.peekValue}>{peek.value}</pre>
          <Button
            ref={copyRef}
            variant="secondary"
            onClick={() => {
              void navigator.clipboard?.writeText(peek.value).then(
                () => setCopied(true),
                () => setCopied(false),
              );
            }}
          >
            <CopyIcon /> {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      )}
    </div>
  );
}
