"use client";
import { editHeaders } from "@/lib/edit-basis";

import { useMemo, useState, useSyncExternalStore } from "react";
import { readApiError } from "../api";
import { createStringStore } from "./preference-store";
import {
  reloadRecipeNotes,
  useOutputStatus,
  type OutputStatus,
} from "./drawer/recipe-notes";
import { pollUntilTerminal } from "./drawer/poll";
import styles from "./ExceptionStrip.module.css";

/**
 * The layer card's exception strip.
 *
 * **The card's only state voice.** A current output's card carries no state
 * text at all; this strip appears on the bottom edge only when the layer's
 * producing output is stale or its latest re-run failed — failure outranks
 * stale in the one strip — with the exact cause copy, a single-output
 * **Re-run** that replaces the dataset in place, and an **Ignore** that is
 * bound to the observed state: another input generation, another failed
 * attempt or another condition re-arms it, and the dismissal survives a
 * reload.
 */

/** The strip's copy, exactly as the spec words it. */
export function stripCopy(status: OutputStatus): string | null {
  if (status.failed) {
    return `${status.operationLabel} failed · re-run`;
  }
  if (status.condition !== "stale") return null;
  const causes = status.causes;
  if (causes.length > 1) return `${causes.length} inputs changed · re-run`;
  const cause = causes[0];
  if (!cause) return null;
  return cause.reason === "upstream_stale"
    ? `${cause.tableName} is out of date · re-run`
    : `${cause.tableName} changed · re-run`;
}

export function ExceptionStrip({ layer }: { layer: { id: string; sql: string } }) {
  const status = useOutputStatus(layer.sql);
  const ignoreStore = useMemo(
    () => createStringStore(`dezfil-strip-ignore:${layer.id}`),
    [layer.id],
  );
  const ignored = useSyncExternalStore(
    ignoreStore.subscribe,
    ignoreStore.read,
    () => null,
  );
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const copy = status ? stripCopy(status) : null;
  if (!status || copy === null) return null;
  // The dismissal is bound to the observed state, not to "ignored" (D2):
  // a matching fingerprint stays quiet; anything else re-arms.
  if (ignored === status.fingerprint) return null;

  const rerun = async () => {
    setRunning(true);
    setFailure(null);
    try {
      const accepted = await fetch(
        `/api/recipes/${encodeURIComponent(status.recipeId)}/steps/${encodeURIComponent(status.stepId)}/run`,
        { method: "POST", headers: status.editRevision ? editHeaders({ editRevision: status.editRevision }) : undefined },
      );
      if (!accepted.ok) throw new Error(await readApiError(accepted));
      // A step's own run is one of the recipe's runs: its one member's
      // job is the attempt to follow.
      const { run } = (await accepted.json()) as { run: { id: string; members: { jobId: string | null }[] } };
      const jobId = run.members[0]?.jobId;
      if (!jobId) throw new Error("The run was accepted without an attempt to follow.");
      const settled = await pollUntilTerminal<{
        state: string;
        error?: { message: string };
      }>({
        read: async () => {
          const r = await fetch(`/api/operations/runs/${encodeURIComponent(jobId)}`);
          if (!r.ok) throw new Error(await readApiError(r));
          return ((await r.json()) as { run: { state: string; error?: { message: string } } }).run;
        },
        done: (view) =>
          view.state === "succeeded" ||
          view.state === "failed" ||
          view.state === "cancelled",
      });
      if (settled.state !== "succeeded") {
        throw new Error(settled.error?.message ?? "The re-run did not finish.");
      }
      // The prior dismissal answered an older state; a fresh output owes it
      // nothing either way.
      ignoreStore.write(null);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : "The re-run did not finish.");
    } finally {
      setRunning(false);
      // The host's settle: recipes, tables and the map re-read, so the strip
      // leaves — or turns failed — from the fresh truth, not this closure's.
      reloadRecipeNotes();
    }
  };

  return (
    <div
      className={styles.strip}
      data-exception-strip={status.failed ? "failed" : "stale"}
      role="status"
    >
      <span className={styles.copy} title={failure ?? undefined}>
        {running ? "re-running…" : (failure ?? copy)}
      </span>
      {!running && (
        <>
          <button
            type="button"
            className={styles.rerun}
            data-strip-rerun
            onClick={() => void rerun()}
          >
            Re-run
          </button>
          <button
            type="button"
            className={styles.ignore}
            data-strip-ignore
            aria-label="Ignore, this state is fine"
            title="Ignore, this state is fine"
            onClick={() => ignoreStore.write(status.fingerprint)}
          >
            ×
          </button>
        </>
      )}
    </div>
  );
}
