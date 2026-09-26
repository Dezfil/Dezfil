import type { PostgisLayerOutcome } from "@/components/builder/use-layer-source-coordinator";
import { Spinner } from "@/components/Spinner";
import { CheckIcon, WarnIcon } from "@/components/ui/icons";
import {
  PostgisCompletionFacts,
  type PostgisDataCompletion,
} from "./PostgisDataDone";
import styles from "./PostgisPane.module.css";

/** The card appears when the import lands; the layer line
 * starts pending and settles to the coordinator's outcome, so the claim
 * "Added to the map" still waits for a confirmed layer. */
export type PostgisLayerLine = PostgisLayerOutcome | { kind: "pending" };

export interface PostgisLayerCompletion extends PostgisDataCompletion {
  outcome: PostgisLayerLine;
}

export function postgisLayerHeading(completion: PostgisLayerCompletion): {
  label: string;
  name: string;
} {
  const { outcome, table } = completion;
  if (outcome.kind === "created") {
    return { label: "Added to the map as", name: outcome.layer.name };
  }
  if (outcome.kind === "unconfirmed") {
    return { label: "Layer creation unconfirmed for", name: table.name };
  }
  return { label: "Imported as", name: table.name };
}

export function PostgisLayerDone({
  completion,
  onDone,
  onImportAnother,
}: {
  completion: PostgisLayerCompletion;
  onDone: () => void;
  onImportAnother: () => void;
}) {
  const heading = postgisLayerHeading(completion);
  const confirmed = completion.outcome.kind === "created";
  const pending = completion.outcome.kind === "pending";
  return (
    <div className={styles.doneCard}>
      <span className={styles.bigCheck} data-warning={(!confirmed && !pending) || undefined}>
        {confirmed || pending ? <CheckIcon /> : <WarnIcon />}
      </span>
      <h3>
        {heading.label} <code>{heading.name}</code>
      </h3>
      <PostgisCompletionFacts completion={completion} />
      {completion.outcome.kind === "pending" ? (
        <p className={styles.layerOutcome} data-kind="pending" role="status">
          <Spinner size={12} />
          Adding to the map…
        </p>
      ) : completion.outcome.kind !== "created" ? (
        <p className={styles.layerOutcome} data-kind={completion.outcome.kind}>
          {completion.outcome.message}
        </p>
      ) : null}
      <div className={styles.doneActions}>
        <button className={styles.primary} type="button" onClick={onDone}>
          Done
        </button>
        <button className={styles.secondary} type="button" onClick={onImportAnother}>
          Import another
        </button>
      </div>
    </div>
  );
}
