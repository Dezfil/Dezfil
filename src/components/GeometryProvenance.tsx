import { GEOMETRY_FORMAT_LABELS, type GeometryRecord } from "@/lib/geometry-evidence";
import styles from "./GeometryProvenance.module.css";

/** The recorded choice, never an inference from today's preview,
 * and its Change door (04): one word in the provenance line, given only
 * where the dataset's source is one the API accepts. */
export function GeometryProvenance({ record, onChange }: { record?: GeometryRecord | null; onChange?: () => void }) {
  if (!record) return null;
  return (
    <span className={styles.record}>
      {" · Geometry: "}<b>{record.columns.join(", ")}</b>
      {" read as "}{GEOMETRY_FORMAT_LABELS[record.format]}, {record.crs.label}
      {onChange && (
        <>
          {" · "}
          <button type="button" className={styles.door} onClick={onChange} data-set-geometry-door="change">Change</button>
        </>
      )}
    </span>
  );
}
