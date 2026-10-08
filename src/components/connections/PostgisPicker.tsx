import Link from "next/link";
import type { PgConnection } from "@/lib/metadata/connections";
import { ChevronIcon, PlusIcon } from "@/components/ui/icons";
import { ConnectionStatus } from "./ConnectionStatus";
import { serverAddress } from "./connection-view";
import styles from "./PostgisPane.module.css";

export function PostgisPicker({
  connections,
  onSelect,
  onNew,
  refusal = null,
}: {
  connections: PgConnection[];
  onSelect: (connection: PgConnection) => void;
  onNew: () => void;
  /** The instance rule's sentence while it holds back adding a connection:
   * New connection is drawn disabled beside it; saved ones stay offered. */
  refusal?: string | null;
}) {
  return (
    <>
      <div className={styles.sectionRow}>
        <span className={styles.sectionTitle}>Saved connections</span>
        <Link className={styles.manage} href="/connections">
          Manage connections
        </Link>
      </div>
      <div className={styles.connectionList}>
        {connections.map((connection) => (
          <button
            key={connection.id}
            className={styles.connectionRow}
            type="button"
            onClick={() => onSelect(connection)}
          >
            <span className={styles.postgresMark}>
              {/* eslint-disable-next-line @next/next/no-img-element -- static PostgreSQL mark */}
              <img src="/logos/postgresql.svg" alt="" />
            </span>
            <span className={styles.connectionMain}>
              <strong>{connection.name}</strong>
              <span className={styles.server} title={serverAddress(connection)}>{serverAddress(connection)}</span>
            </span>
            <ConnectionStatus connection={connection} />
            <span className={styles.rowChevron} aria-hidden>
              <ChevronIcon />
            </span>
          </button>
        ))}
      </div>
      <button className={styles.newConnection} type="button" disabled={refusal !== null} onClick={onNew}>
        <PlusIcon /> New connection
      </button>
      {refusal ? <p className={styles.refusal}>{refusal}</p> : null}
    </>
  );
}
