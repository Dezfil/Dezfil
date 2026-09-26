"use client";

import styles from "./TablePreviewGrid.module.css";

export interface PreviewColumn {
  name: string;
  type: string;
}

/**
 * The dataset page's Data preview grid: the table's columns with their
 * types, and its first rows, a null shown as the empty glyph. Extracted
 * from the detail screen at its touch. While the set-geometry panel is
 * open the grid shows the preview's own rows, the chosen columns tagged
 * and each unreadable row marked: `marks` is indexed like `rows`,
 * so a mark cannot drift from its row.
 */
export function TablePreviewGrid({
  columns,
  rows,
  tags = {},
  marks,
}: {
  columns: readonly PreviewColumn[];
  rows: readonly Record<string, unknown>[];
  /** The chosen columns and the drawn word on each. */
  tags?: Readonly<Record<string, string>>;
  /** Per row, whether it keeps no geometry though it holds a value. */
  marks?: readonly boolean[];
}) {
  // Own properties only: a column named like something the prototype
  // carries (`__proto__`, `constructor`) gets no tag it was not given.
  const tagOf = (name: string) => (Object.hasOwn(tags, name) ? tags[name] : undefined);
  return (
    <div className={styles.gridWrap}>
      <table className={styles.grid}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.name} data-pick={tagOf(c.name) !== undefined || undefined}>
                <span className={styles.colName}>{c.name}</span>
                <span className={styles.colType}>{c.type}</span>
                {tagOf(c.name) !== undefined && <span className={styles.pickTag}>{tagOf(c.name)}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} data-bad={marks?.[i] || undefined}>
              {columns.map((c) => (
                <td
                  key={c.name}
                  title={String(row[c.name] ?? "")}
                  data-pick={tagOf(c.name) !== undefined || undefined}
                  data-bad={(marks?.[i] && tagOf(c.name) !== undefined) || undefined}
                >
                  {row[c.name] === null || row[c.name] === undefined ? (
                    <span className={styles.nullCell}>∅</span>
                  ) : (
                    String(row[c.name])
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
