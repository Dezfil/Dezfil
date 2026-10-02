import { failureProse, type AnswerFailure } from "../widgets/dashboard-state";
import styles from "./PublishedView.module.css";

export interface FailedLayer {
  id: string;
  name: string;
  failure: AnswerFailure | null;
}

/** Refusals another try cannot change: a layer whose SQL reads more than
 * the link publishes is refused the same way every time. */
const SETTLED = new Set(["catalogue_not_published"]);

/** The published viewer's failure note: each layer it cannot draw, by its
 * name, with the reader's line for why, and Retry while a retry could
 * clear one of them. */
export function FailedLayers({ layers, onRetry }: { layers: FailedLayer[]; onRetry: () => void }) {
  if (layers.length === 0) return null;
  const retries = layers.some((l) => !SETTLED.has(l.failure?.code ?? ""));
  return (
    <div className={styles.failedList}>
      {layers.map((l) => (
        <span key={l.id} className={styles.layerFailed} role="alert" data-layer-failed={l.id}>
          &ldquo;{l.name}&rdquo; unavailable: {failureProse(l.failure, "reader")}
        </span>
      ))}
      {/* A transient failure clears on the server, not in the
          payload the reader already holds — without this the only
          way back is reloading the page by hand. */}
      {retries && (
        <button className={styles.failedRetry} data-layer-retry onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
