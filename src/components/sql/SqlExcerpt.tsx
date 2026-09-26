"use client";

import { useMemo } from "react";
import { highlightTree } from "@lezer/highlight";
import { PostgreSQL } from "@codemirror/lang-sql";
import { tags, type Tag } from "@lezer/highlight";
import styles from "./SqlConsole.module.css";

/**
 * A read-only, syntax-coloured excerpt of SQL for the history cards: the
 * editor's own grammar drives the colouring, so a card reads like the
 * editor without mounting one.
 */
const CLASS: [Tag | readonly Tag[], string][] = [
  [tags.keyword, styles.tkKw],
  [tags.typeName, styles.tkKw],
  [[tags.string, tags.special(tags.string)], styles.tkStr],
  [[tags.number, tags.bool, tags.null], styles.tkNum],
  [[tags.comment, tags.lineComment], styles.tkCm],
  [tags.function(tags.variableName), styles.tkFn],
];

function classFor(tagList: readonly Tag[]): string | null {
  for (const t of tagList) {
    for (const [match, cls] of CLASS) {
      const list = Array.isArray(match) ? (match as readonly Tag[]) : [match as Tag];
      if (list.includes(t)) return cls;
    }
  }
  return null;
}

/** `className` lets a host set the text's face (the results band's
 * provenance box is the code face,); the token colours stay the
 * console's. */
export function SqlExcerpt({ sql, clamped, className }: { sql: string; clamped: boolean; className?: string }) {
  const pieces = useMemo(() => {
    const tree = PostgreSQL.language.parser.parse(sql);
    const out: { text: string; cls: string | null }[] = [];
    let pos = 0;
    highlightTree(
      tree,
      { style: (tagList) => classFor(tagList) },
      (from, to, cls) => {
        if (from > pos) out.push({ text: sql.slice(pos, from), cls: null });
        out.push({ text: sql.slice(from, to), cls });
        pos = to;
      },
    );
    if (pos < sql.length) out.push({ text: sql.slice(pos), cls: null });
    return out;
  }, [sql]);
  return (
    <div className={className ?? styles.cardSql} data-clamped={clamped || undefined}>
      {pieces.map((p, i) =>
        p.cls ? (
          <span key={i} className={p.cls}>
            {p.text}
          </span>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </div>
  );
}
