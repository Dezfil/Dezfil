"use client";

import type { TableInspection } from "../api";
import { ErrorNote } from "../ui/ErrorNote";
import { SqlExcerpt } from "../sql/SqlExcerpt";
import { ASSUMED, NO_ENDPOINT, NO_SQL_PROVIDER, provenanceOf } from "./provenance-model";
import type { ReadState } from "./use-dataset-reads";
import styles from "./ResultsBand.module.css";

const when = (iso: string) => new Date(iso).toLocaleString();

/**
 * The Provenance tab: what the dataset's record says, never recomputed —
 * the producing line with each input's resolution and the recorded
 * assumption, then the SQL that ran in the reference's box, or the
 * provider disclosure field by field; an imported source's provenance in
 * the record's terms, its last-produced time exactly when the record
 * carries one.
 */
export function ProvenanceTab({ inspection, labelOf, retry }: { inspection: ReadState<TableInspection>; labelOf: (operationId: string) => string | null; retry: () => void }) {
  if (inspection.status === "reading") {
    return (
      <div className={styles.empty} data-band-reading>
        <div>Reading the dataset…</div>
      </div>
    );
  }
  if (inspection.status === "failed") {
    return (
      <div className={styles.errorWrap} data-band-read-failed>
        <ErrorNote message={inspection.message} onRetry={retry} retryLabel="Retry" />
      </div>
    );
  }
  if (inspection.status === "gone") return null;
  const p = provenanceOf(inspection.value, inspection.value.inputs, labelOf);
  if (p.kind === "imported") {
    return (
      <div className={styles.prov} data-band-provenance="imported">
        <p className={styles.provFacts}>
          {p.sentence}
          {p.producedAt ? (
            <>
              {" · "}
              <time dateTime={p.producedAt} data-produced-at={p.producedAt}>
                {when(p.producedAt)}
              </time>
            </>
          ) : null}
        </p>
        {p.assumed ? <p className={styles.provFacts} data-band-assumed>{ASSUMED}</p> : null}
      </div>
    );
  }
  return (
    <div className={styles.prov} data-band-provenance="derived">
      <p className={styles.provFacts}>
        Produced by <b data-band-operation>{p.operation}</b>
        {p.ranAt ? (
          <>
            {" · ran "}
            <time dateTime={p.ranAt} data-ran-at={p.ranAt}>
              {when(p.ranAt)}
            </time>
          </>
        ) : null}
        {p.inputs.length ? (
          <>
            {" · read "}
            {p.inputs.map((i, n) => (
              <span key={`${i.name}-${n}`} data-band-input={i.name} data-resolution={i.resolution ?? undefined}>
                {n > 0 ? ", " : ""}
                <code>{i.name}</code>
                {i.resolution ? ` (${i.resolution})` : ""}
              </span>
            ))}
          </>
        ) : null}
      </p>
      {p.assumed ? <p className={styles.provFacts} data-band-assumed>{ASSUMED}</p> : null}
      {p.body.kind === "sql" ? (
        <div className={styles.sqlBox} data-band-sql>
          <SqlExcerpt sql={p.body.sql} clamped={false} className={styles.sqlText} />
        </div>
      ) : (
        <div className={styles.sqlBox} data-band-disclosure>
          <dl className={styles.disclosure}>
            <div>
              <dt>endpoint</dt>
              <dd data-band-endpoint>{p.body.endpoint ?? NO_ENDPOINT}</dd>
            </div>
            {p.body.fields.map((f) => (
              <div key={f.label}>
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
          <p className={styles.provFacts}>{NO_SQL_PROVIDER}</p>
        </div>
      )}
    </div>
  );
}
