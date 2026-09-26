import type { DataTable } from "@/components/api";
import { formatCount } from "@/components/api";
import type { PgConnection } from "@/lib/metadata/connections";
import { CheckIcon } from "@/components/ui/icons";
import { relationKey, type PostgisRemoteRelation } from "./postgis-pane-types";
import styles from "./PostgisPane.module.css";

export interface PostgisDataCompletion {
  connection: PgConnection;
  relation: PostgisRemoteRelation;
  table: DataTable;
  filter: string;
}

export function PostgisCompletionFacts({
  completion,
}: {
  completion: PostgisDataCompletion;
}) {
  const { connection, relation, table, filter } = completion;
  return (
    <p>
      {formatCount(table.rowCount)} rows · {table.geometryType ?? "no geometry"}
      {" · snapshot of "}
      <span className={styles.doneRelation}>{relationKey(relation)}</span>
      {` from ${connection.name}`}
      {filter ? " · filtered" : ""}
    </p>
  );
}

export function PostgisDataDone({
  completion,
  onOpenTable,
  onImportAnother,
}: {
  completion: PostgisDataCompletion;
  onOpenTable: (table: DataTable) => void;
  onImportAnother: () => void;
}) {
  const { table } = completion;
  return (
    <div className={styles.doneCard}>
      <span className={styles.bigCheck}>
        <CheckIcon />
      </span>
      <h3>
        Imported as <code>{table.name}</code>
      </h3>
      <PostgisCompletionFacts completion={completion} />
      <div className={styles.doneActions}>
        <button
          className={styles.primary}
          type="button"
          onClick={() => onOpenTable(table)}
        >
          Open table
        </button>
        <button className={styles.secondary} type="button" onClick={onImportAnother}>
          Import another
        </button>
      </div>
    </div>
  );
}
