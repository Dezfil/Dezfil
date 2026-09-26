"use client";

import { ErrorNote } from "../ui/ErrorNote";
import { failureProse, type AnswerState } from "./dashboard-state";
import styles from "./Widgets.module.css";

/**
 * The settle lane's truth surface, shared by the builder and the
 * published viewer. While a computed layer re-renders under a selection
 * the stage reads as applying; when the settle fails, the canonical
 * render is showing and this surface says so — the selection is visibly
 * unapplied (gate decision 1), named per layer, with a retry.
 */
export function SettleStatus({
  states,
  layerNames,
  audience,
  onRetry,
}: {
  states: Record<string, AnswerState>;
  layerNames: Record<string, string>;
  audience: "author" | "reader";
  onRetry: (layerId: string) => void;
}) {
  const failed = Object.entries(states).filter(
    ([, s]) => s.status === "failed",
  );
  const busy = Object.values(states).some(
    (s) => s.status === "updating" || s.status === "loading",
  );
  if (failed.length === 0 && !busy) return null;
  return (
    <div className={styles.settleStatus} data-settle-status>
      {failed.map(([id, s]) => (
        <div key={id} className={styles.noteFloat} data-settle-failed={id}>
          <ErrorNote
            tone="warn"
            message={
              <>
                Selection not applied to &ldquo;
                {layerNames[id] ?? "this layer"}&rdquo;:{" "}
                {failureProse(s.error, audience)}
              </>
            }
            onRetry={() => onRetry(id)}
          />
        </div>
      ))}
      {/* Busy shows ALONGSIDE failures: with several settle layers one can
          be recomputing while another stays failed, and suppressing the
          in-flight marker would leave that layer's canonical render
          unexplained. */}
      {busy && (
        <div className={styles.settleBusy} data-settle-busy>
          Applying selection…
        </div>
      )}
    </div>
  );
}
