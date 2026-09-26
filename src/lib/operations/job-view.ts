import type { OperationJob } from "@/lib/metadata/jobs";

/**
 * What a run looks like on the wire.
 *
 * One shape for every state, so a caller reads a queued run and a finished one
 * the same way. Fields that have not happened yet are **absent** rather than
 * present and meaningless: a queued run has no start time, and a run that has
 * not succeeded has no output.
 *
 * **There is deliberately no completion percentage** (G6). The engine's own
 * progress signal is unreachable from the hardened instance's connections, and
 * it would measure one statement of a run made of several even if it were
 * reachable. A surface shows elapsed time, computed from `startedAt`. Emitting
 * a zero here would read as a stalled measurement rather than an absent one,
 * which is why the field does not exist at all.
 */
export interface OperationRunView {
  id: string;
  operation: string;
  state: OperationJob["state"];
  subject: { kind: OperationJob["subjectKind"]; id: string };
  parameters: Record<string, unknown>;
  acceptedAt: string;
  startedAt?: string;
  finishedAt?: string;
  output?: { id: string; name: string };
  /** Non-fatal facts about this run, present on the answer that accepted it. */
  warnings?: string[];
  /**
   * What a provider run asked, for a run that published one.
   *
   * **Read from the output's own record rather than stored twice.** The
   * disclosure is written once, inside the publication transaction, and a copy
   * on the job could disagree with it — a run resource saying one thing and the
   * dataset another is worse than a run resource saying nothing. Absent for
   * every ordinary run, whose evidence is the SQL its output carries.
   */
  disclosure?: Record<string, unknown>;
  error?: { code: string; message: string };
}

export function jobView(job: OperationJob): OperationRunView {
  return {
    id: job.id,
    operation: job.operation,
    state: job.state,
    subject: { kind: job.subjectKind, id: job.subjectId },
    parameters: job.parameters ?? {},
    acceptedAt: job.acceptedAt,
    ...(job.startedAt ? { startedAt: job.startedAt } : {}),
    ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
    ...(job.warnings?.length ? { warnings: job.warnings } : {}),
    ...(job.outputId && job.outputName
      ? {
          output: { id: job.outputId, name: job.outputName },
          ...(disclosureOf(job) ? { disclosure: disclosureOf(job)! } : {}),
        }
      : {}),
    ...(job.errorCode
      ? {
          error: {
            code: job.errorCode,
            message: job.errorMessage ?? "The run failed.",
          },
        }
      : {}),
  };
}

/**
 * The request **this run** made, when it made one.
 *
 * Read from the job's own row, not from the output's provenance. Those look
 * interchangeable and are not: a step re-run replaces its output in place, so
 * reading the table made every older job report the newest run's cache and
 * wire counts — and deleting the output and reclaiming its name could attach
 * an unrelated run's disclosure, or silently remove it. What a run asked is a
 * fact about the run, and it settles in the same statement the run does.
 * Found at the cross-model review.
 */
function disclosureOf(job: OperationJob): Record<string, unknown> | null {
  const disclosure = job.disclosure;
  return typeof disclosure === "object" &&
    disclosure !== null &&
    !Array.isArray(disclosure)
    ? (disclosure as Record<string, unknown>)
    : null;
}
