"use client";

import { useEffect, useRef, useState } from "react";
import {
  SNIPPETS,
  describeSnippet,
  renderSnippet,
  type SnippetContext,
} from "./sql-snippets";
import styles from "./SqlConsole.module.css";

/** The Snippets menu: five editable starting
 * points, seeded with the selected table; the host applies the ownership
 * rule; nothing runs on insertion. */
export function SnippetsMenu({
  context,
  onPick,
}: {
  context: SnippetContext;
  onPick: (sql: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!hostRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div ref={hostRef} className={styles.menuHost}>
      <button
        type="button"
        className={styles.ghostBtn}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Insert a starting point for a spatial query"
        onClick={() => setOpen((o) => !o)}
      >
        Snippets
      </button>
      {open && (
        <div className={styles.menu} role="menu" aria-label="Snippets">
          {SNIPPETS.map((s) => (
            <button
              key={s.id}
              type="button"
              role="menuitem"
              className={styles.menuItem}
              onClick={() => {
                setOpen(false);
                onPick(renderSnippet(s, context));
              }}
            >
              <b>{s.name}</b>
              <span>{describeSnippet(s, context)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
