import type { StagingInput } from "@/lib/query/staging";
import type { ApiError } from "@/lib/api/errors";

/**
 * What a run has to do before it has a statement at all.
 *
 * The lane hands over its own signal and what is left of its own budget, so a
 * preparation is cancelled and timed exactly as the publication that follows
 * it is — contract is that execution is timed from when a run starts running,
 * and a provider phase outside that would be time nothing measured.
 */
export interface PreparationContext {
  signal?: AbortSignal;
  /** Wall-clock instant by which the whole run must be over, publication
   * included. Not a fresh budget: a slow preparation leaves less, never more. */
  deadlineAt: number;
  /** The lane's coded timeout, so work that runs long fails as a run that ran
   * long rather than as a query that did. */
  timeoutError: () => ApiError;
}

export interface PreparedPublication {
  /** Private mounts passed only into this job’s evaluation. */
  inputs?: readonly StagingInput[];
  /** The statement to publish, now that what it reads exists. */
  sql: string;
  /**
   * What the output's record carries **in place of** that statement (J9).
   *
   * A provider run's statement names a private staging input, so publishing it
   * would name an ephemeral input in the registry. The doctrine already says what
   * belongs there instead: the request the run made.
   */
  disclosure: Record<string, unknown>;
  /** Called whatever the run's outcome — success, failure, cancellation or
   * timeout. The staging artifact is run-owned. */
  cleanup: () => Promise<void>;
}
