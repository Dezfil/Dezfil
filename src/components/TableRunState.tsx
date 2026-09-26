"use client";

import { useState } from "react";
import { readApiError } from "./api";
import type { DataTable } from "./api";
import { stepsByOutput } from "./builder/drawer/derived-tables";
import { pollUntilTerminal } from "./builder/drawer/poll";
import type { RecipeSummary } from "./builder/drawer/recipe-model";
import styles from "./TableRunState.module.css";

/**
 * The permanent re-run home: an operation output's own run state on its
 * table detail page — current, stale with every reason, failed with the
 * coded error, or **broken** with Re-run unavailable — and the
 * single-output Re-run itself, offered only while a live, runnable step
 * owns the existing dataset.
 *
 * This is what keeps a table-only output, a dataset whose layer was
 * deleted, and an ignored card from going silently stale with no UI path
 * back — the strip cannot be the only door, because not every output has a
 * card. A dataset whose recipe or step was deleted says it has no in-place
 * owner and points at running the tool again; a silent no-op is the
 * failure mode the broken state exists to not repeat.
 */
export function TableRunState({
  recipes,
  table,
  onSettled,
}: {
  /** Null while the recipe read is still out (or failed): ownership is
   * then **unknown**, which is not the same answer as "nothing owns it" —
   * a screen that said ownerless during loading hid Re-run from every
   * operation table for a beat, and for ever on a failed read. */
  recipes: RecipeSummary[] | null;
  table: Pick<DataTable, "id" | "name" | "source">;
  /** The run replaced the dataset; the screen re-reads. */
  onSettled: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  if (recipes === null) return null;
  const ref = stepsByOutput(recipes).get(table.id);
  if (!ref) {
    if (table.source !== "operation") return null;
    return (
      <span className={styles.state} data-run-state="ownerless">
        {" · "}an operation made this dataset, but nothing owns it any more;
        re-running it in place is not possible. Run the tool again under a
        new name to rebuild it.
      </span>
    );
  }
  const recipe = recipes.find((r) => r.id === ref.recipeId);
  const step = recipe?.steps.find((s) => s.id === ref.stepId);
  if (!step) return null;

  const attempt = step.latestAttempt as {
    state?: string;
    error?: { code: string; message: string };
  } | null;
  const failed =
    attempt?.state === "failed" && attempt.error ? attempt.error : null;
  const causes = (step.causes ?? []) as {
    reason: string;
    tableName: string;
  }[];
  const missing = (step.missingInputs ?? []) as { tableName: string }[];
  const broken = step.condition === "broken" || missing.length > 0;
  const stale = step.condition === "stale";

  const rerun = async () => {
    setRunning(true);
    setFailure(null);
    try {
      const accepted = await fetch(
        `/api/recipes/${encodeURIComponent(ref.recipeId)}/steps/${encodeURIComponent(ref.stepId)}/run`,
        { method: "POST" },
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
          const r = await fetch(
            `/api/operations/runs/${encodeURIComponent(jobId)}`,
          );
          if (!r.ok) throw new Error(await readApiError(r));
          return (
            (await r.json()) as {
              run: { state: string; error?: { message: string } };
            }
          ).run;
        },
        done: (view) =>
          view.state === "succeeded" ||
          view.state === "failed" ||
          view.state === "cancelled",
      });
      if (settled.state !== "succeeded") {
        throw new Error(settled.error?.message ?? "The re-run did not finish.");
      }
    } catch (e) {
      setFailure(e instanceof Error ? e.message : "The re-run did not finish.");
    } finally {
      setRunning(false);
      onSettled();
    }
  };

  return (
    <span className={styles.state}>
      {" · "}made by {ref.operation.replace(/_/g, " ")}
      {broken ? (
        <span className={styles.failed} data-run-state="broken">
          {" · "}broken: {missing.length > 0
            ? `its input ${missing.map((m) => `“${m.tableName}”`).join(", ")} no longer exists`
            : "an input is missing"}
          ; re-run is unavailable until the input is restored
        </span>
      ) : failed ? (
        <span className={styles.failed} data-run-state="failed">
          {" · "}latest re-run failed ({failed.code}): {failed.message}
        </span>
      ) : stale ? (
        <span className={styles.stale} data-run-state="stale">
          {" · "}out of date:{" "}
          {causes
            .map((c) =>
              c.reason === "upstream_stale"
                ? `${c.tableName} is out of date`
                : `${c.tableName} changed`,
            )
            .join(", ")}
        </span>
      ) : (
        <span className={styles.current} data-run-state="current">
          {" · "}current
        </span>
      )}
      {failure && (
        <span className={styles.failed} role="alert">
          {" · "}
          {failure}
        </span>
      )}
      {!broken && (
        <button
          type="button"
          className={styles.rerun}
          data-detail-rerun
          disabled={running}
          onClick={() => void rerun()}
        >
          {running ? "re-running…" : "Re-run"}
        </button>
      )}
    </span>
  );
}
