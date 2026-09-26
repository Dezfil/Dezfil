"use client";

import { IconCaret, IconFolder } from "../gallery-icons";
import { Menu, MenuItem } from "../ui/Menu";
import { CheckIcon } from "../ui/icons";
import {
  activeRow,
  printedCount,
  type ProjectScope,
  type ScopeRow,
} from "./model";
import styles from "./ScopeFilter.module.css";

/**
 * The project filter: first in the toolbar, the active scope and its
 * count on its face, the popover listing All projects, every project
 * and Not in a project with the active row checked. The rows' counts
 * arrive derived; this control only presents and picks. What a row
 * prints is the model's printedCount — All projects prints none, on the
 * face and in the menu alike, and every other row keeps its number.
 * Both count elements carry `data-scope-count` so a check can read the
 * count itself: a row's text is its project's name followed by its
 * number, and a bare `toContainText("2")` against it matches any name
 * holding a 2 — which is how a count assertion passes with the count
 * gone.
 */
export function ScopeFilter({
  rows,
  scope,
  onPick,
  size = "chrome",
}: {
  rows: ScopeRow[];
  scope: ProjectScope;
  onPick: (id: string) => void;
  /** The toolbar's chrome height (page 12 A), or the add-layer
   * catalog's own control height (page 17 A). */
  size?: "chrome" | "compact";
}) {
  const active = activeRow(rows, scope);
  const faceCount = printedCount(active);
  const scoped = scope.kind === "none" || scope.kind === "project";
  const triggerClass = [
    styles.trigger,
    scoped ? styles.triggerOn : null,
    size === "compact" ? styles.triggerCompact : null,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <Menu
      label="Filter by project"
      className={styles.wrap}
      align="start"
      triggerClassName={triggerClass}
      menuClassName={styles.menu}
      trigger={
        <span className={styles.face} data-on={scoped || undefined}>
          <IconFolder />
          <span className={styles.faceName}>{active.name}</span>
          {faceCount !== null && (
            <span className={styles.faceCount} data-scope-count>
              · {faceCount}
            </span>
          )}
          <span className={styles.caret}>
            <IconCaret />
          </span>
        </span>
      }
    >
      {rows.map((row) => {
        const count = printedCount(row);
        return (
          <MenuItem
            key={row.id}
            className={
              [
                row.id === "none" ? styles.unfiledRow : null,
                row.id === active.id && (scoped || row.id === "all")
                  ? styles.activeRow
                  : null,
              ]
                .filter(Boolean)
                .join(" ") || undefined
            }
            onSelect={() => onPick(row.id)}
          >
            <span className={styles.rowName}>{row.name}</span>
            {count !== null && (
              <span className={styles.rowCount} data-scope-count>
                {count}
              </span>
            )}
            <span className={styles.rowCheck}>
              {row.id === active.id && (scoped || row.id === "all") ? (
                <CheckIcon />
              ) : null}
            </span>
          </MenuItem>
        );
      })}
    </Menu>
  );
}
