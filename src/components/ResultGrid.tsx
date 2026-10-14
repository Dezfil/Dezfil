import { formatCount } from "./api";
import type { QueryResult } from "./query-types";
import styles from "./ResultGrid.module.css";

/**
 * The result table shared by the Query workspace and the builder's SQL
 * workbench: a meta line (row/column counts, runtime, truncation note),
 * then the grid of first rows. The `fill` variant stretches to its
 * container instead of the workspace's page cap; `maxRows` tightens the
 * server's preview cap further for hosts that want a lighter table.
 */
export function ResultGrid({
  result,
  fill = false,
  maxRows,
}: {
  result: QueryResult;
  fill?: boolean;
  maxRows?: number;
}) {
  const rows =
    maxRows !== undefined ? result.preview.slice(0, maxRows) : result.preview;
  const truncated = result.previewTruncated || rows.length < result.rowCount;
  // Own properties only: a row without a column named like something the
  // prototype carries (`__proto__`, `constructor`) shows the empty glyph.
  const cellOf = (row: Readonly<Record<string, unknown>>, name: string) => (Object.hasOwn(row, name) ? row[name] : undefined);
  return (
    <div className={styles.result} data-fill={fill || undefined}>
      <div className={styles.resultMeta}>
        <span>
          <strong>{formatCount(result.rowCount)}</strong> rows
        </span>
        <span>{result.columns.length} columns</span>
        <span>{result.runtimeMs} ms</span>
        {truncated && (
          <span className={styles.truncated}>
            showing first {formatCount(rows.length)}
          </span>
        )}
      </div>
      {rows.length === 0 ? (
        <div className={styles.empty}>
          The query ran and returned zero rows.
        </div>
      ) : (
        <div className={styles.gridWrap}>
          <table className={styles.grid}>
            <thead>
              <tr>
                {result.columns.map((c) => (
                  <th key={c.name}>
                    <span className={styles.colName}>{c.name}</span>
                    <span className={styles.colType}>{c.type}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  {result.columns.map((c) => {
                    const value = cellOf(row, c.name);
                    return (
                      <td key={c.name} title={String(value ?? "")}>
                        {value === null || value === undefined ? (
                          <span className={styles.nullCell}>∅</span>
                        ) : (
                          String(value)
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
