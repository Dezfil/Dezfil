import type { PostgisPreviewData } from "./use-postgis-preview";
import styles from "./PostgisPane.module.css";

const PREVIEW_CELL_MAX_LENGTH = 120;

export function previewCell(value: unknown): string {
  let text: string;
  if (value === null || value === undefined) text = "NULL";
  else if (typeof value === "string") text = value;
  else if (typeof value === "number" || typeof value === "boolean") {
    text = String(value);
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > PREVIEW_CELL_MAX_LENGTH
    ? `${text.slice(0, PREVIEW_CELL_MAX_LENGTH)}…`
    : text;
}

export function PostgisPreviewTable({ data }: { data: PostgisPreviewData }) {
  return (
    <div className={styles.previewScroll}>
      <table className={styles.previewTable}>
        <thead>
          <tr>
            {data.columns.map((column) => (
              <th key={column.name} data-spatial={column.spatialKind || undefined}>
                {column.name}
                <small>{column.type}</small>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, index) => (
            <tr key={index}>
              {data.columns.map((column) => (
                <td key={column.name} data-spatial={column.spatialKind || undefined}>
                  {previewCell(row[column.name])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {data.rows.length === 0 ? (
        <div className={styles.previewEmpty}>No rows match the current filter.</div>
      ) : null}
    </div>
  );
}
