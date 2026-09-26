import type { PgConnection } from "@/lib/metadata/connections";
import { STATUS_LABELS } from "./connection-view";
import styles from "./ConnectionStatus.module.css";

export function ConnectionStatus({
  connection,
  checking = false,
}: {
  connection: PgConnection;
  checking?: boolean;
}) {
  return (
    <span
      className={styles.pill}
      data-status={checking ? "checking" : connection.status}
      role={checking ? "status" : undefined}
    >
      {checking ? <span className={styles.spinner} /> : <span className={styles.dot} />}
      {checking ? "Checking…" : STATUS_LABELS[connection.status]}
    </span>
  );
}
