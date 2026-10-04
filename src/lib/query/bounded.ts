import { inDelegatedDeletionWork } from "@/lib/auth/account-deletion-work";
import { authorityOf } from "./context";
import { admitEvaluationWork } from "./work-admission";
import { normalizeEngineError } from "./engine-message";
import { leaseStagingInputs, type StagingInput } from "./staging";
import { requireDatasetScope, type DatasetScope } from "./access";
import type { DuckDBConnection } from "@duckdb/node-api";
import { connectQueryInstance } from "@/lib/duckdb";
import { limits } from "@/lib/limits";
import { ApiError, EvaluationCancelled } from "@/lib/api/errors";
import { registerTableViews } from "./views";
import { trackInflight } from "./inflight";
import { pinBindings, type BindingSnapshot } from "./binding-snapshot";
import { foldEvaluation, openCollections } from "./evaluation-inputs";

// The boundary's callers import the cancellation from here; it lives with
// the API errors so the response mapping stays cycle-free.
export { EvaluationCancelled };

/**
 * The bounded-evaluation boundary: the one door to the hardened instance
 * for user SQL. Every evaluation gets a wall-clock budget covering the
 * whole thing — connection acquisition (the first caller after boot pays
 * for instance creation), the connection-local view registration, and the engine
 * statements — and reaching the budget genuinely interrupts the engine on
 * the evaluation's own connection, which is never shared. The caller's
 * departure (an aborted request) cancels the same way, silently.
 *
 * An abandoned registration is interrupted until it settles: its per-table
 * error handling degrades that one pass (see query/views), the next
 * evaluation re-registers. The connection is released only once the
 * abandoned work settles. Engine statements are bounded by interruption,
 * re-fired on an interval so a deadline that lands between two statements
 * still stops the next one.
 */

/** How often the interrupt re-fires once a budget is exhausted, so work
 * started just after the deadline cannot slip past a one-shot signal. */
const REINTERRUPT_MS = 250;

export interface EvaluationOptions {
  /** Authority retained by this evaluation, independent of a visitor. */
  scope: DatasetScope;
  /** Opaque inputs held only by the provider job that prepared them. */
  inputs?: readonly StagingInput[];
  /** The caller's departure; aborting cancels the evaluation silently. */
  signal?: AbortSignal;
  /** Budget override for the lanes with their own documented bound (the
   * tile build). Everything else takes the configured query timeout. */
  budgetMs?: number;
  /** Error override to pair with `budgetMs` — the lane's own coded error. */
  timeoutError?: () => ApiError;
  /** Materialization opts into one catalog snapshot for all its statements. */
  pinBindings?: boolean;
}

/**
 * Per-evaluation state the boundary exposes to its callback. Inner
 * degradation catches (the widget loop) ask `interrupted()` instead of
 * sniffing error text, which user data can forge — a value literally
 * containing "interrupt" must stay an ordinary per-item error.
 */
export interface EvaluationBounds {
  /** True once the boundary has interrupted this evaluation — its budget
   * fired or its caller left. Whatever error surfaced after that is the
   * boundary's outcome, not the statement's. */
  interrupted(): boolean;
  /** Present only when this evaluation requested pinned bindings. */
  bindings?: BindingSnapshot;
}

/**
 * True when the engine refused an allocation over the configured memory
 * budget. Anchored to the engine's own error prefix so user data quoting
 * the phrase cannot forge it. Inner degradation catches rethrow it raw,
 * and the boundary maps it to the coded error.
 */
export function isOutOfMemory(error: unknown): boolean {
  return error instanceof Error && /^out of memory error/i.test(error.message);
}

/**
 * True for outcomes the boundary has already ruled on — a timeout, the
 * memory budget, or a cancellation. For degradation catches sitting
 * *above* a nested bounded evaluation (fill and elevation fallbacks): a
 * genuine compute failure may degrade, but these must propagate.
 */
export function isBoundedOutcome(error: unknown): boolean {
  return (
    error instanceof EvaluationCancelled ||
    (error instanceof ApiError &&
      (error.code === "query_timeout" ||
        error.code === "query_memory_exceeded"))
  );
}

function defaultTimeoutError(budgetMs: number): ApiError {
  return new ApiError(
    "query_timeout",
    `The query exceeded the ${Math.round(
      budgetMs / 1000,
    )}s timeout. Narrow it down, or raise DEZFIL_QUERY_TIMEOUT_S.`,
    408,
  );
}

function memoryError(): ApiError {
  return new ApiError(
    "query_memory_exceeded",
    `The query exceeded the ${Math.round(
      limits.queryMemoryMb,
    )} MB memory budget shared by all queries. Narrow it down, or raise DEZFIL_QUERY_MEMORY_MB.`,
    400,
  );
}

export function boundedEvaluation<T>(
  fn: (conn: DuckDBConnection, bounds: EvaluationBounds) => Promise<T>,
  options: EvaluationOptions,
): Promise<T> {
  // Registered as an in-flight reader: artifact retirement waits for
  // evaluations that may have bound a replaced artifact's path.
  return trackInflight(inDelegatedDeletionWork(authorityOf(options.scope), () => runBoundedEvaluation(fn, options)));
}

async function runBoundedEvaluation<T>(
  fn: (conn: DuckDBConnection, bounds: EvaluationBounds) => Promise<T>,
  options: EvaluationOptions,
): Promise<T> {
  const { signal, scope } = options ?? {};
  requireDatasetScope(scope);
  if (signal?.aborted) throw new EvaluationCancelled();
  // Whatever this evaluation binds is evidence for the artifacts being
  // assembled where it was started.
  const collections = openCollections();

  const budgetMs = options.budgetMs ?? limits.queryTimeoutMs;
  const timeoutError = (): ApiError =>
    options.timeoutError ? options.timeoutError() : defaultTimeoutError(budgetMs);
  const deadline = Date.now() + budgetMs;

  // Acquisition joins the bound: the first evaluation after boot (or a
  // reset) pays for instance creation and extension loading here, and a
  // stall in that must not outlive the budget or the caller. An abandoned
  // acquisition releases its connection whenever it finally arrives.
  const staging = leaseStagingInputs(scope, options.inputs);
  const admission = admitEvaluationWork(scope);
  const connecting = connectQueryInstance();
  connecting.catch(() => {});
  const conn = await new Promise<DuckDBConnection>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(timeoutError()),
      Math.max(deadline - Date.now(), 1),
    );
    const onAbort = () => reject(new EvaluationCancelled());
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    connecting.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    });
  }).catch((error: unknown) => {
    staging.release();
    connecting.then((late) => late.disconnectSync()).catch(() => {}).finally(() => admission.release());
    throw error;
  });

  let deferDisconnect = false;
  try {
    // Preparation: mount only this scope’s local views, racing the budget
    // and the caller's departure. A genuine registration failure propagates
    // like it always has. The abandonment probe lets an interrupted pass
    // exit without affecting other connections (see query/views).
    let prepAbandoned = false;
    let bindings: BindingSnapshot | undefined;
    const registration = registerTableViews(scope, conn, () => prepAbandoned,
      async (registered) => {
        await staging.mount(conn, () => prepAbandoned);
        if (options.pinBindings) bindings = await pinBindings(conn, registered);
      }, admission,
    );
    registration.catch(() => {});
    try {
      await new Promise<void>((resolve, reject) => {
        const prepTimer = setTimeout(
          () => reject(timeoutError()),
          Math.max(deadline - Date.now(), 1),
        );
        const onPrepAbort = () => reject(new EvaluationCancelled());
        signal?.addEventListener("abort", onPrepAbort, { once: true });
        // The caller may have left between the entry check and the listener
        // attach — a settled promise ignores the double reject.
        if (signal?.aborted) onPrepAbort();
        registration.then(resolve, reject).finally(() => {
          clearTimeout(prepTimer);
          signal?.removeEventListener("abort", onPrepAbort);
        });
      });
    } catch (error) {
      // Abandoned during mounting: interrupt whatever the
      // registration is doing on this connection until it settles — a
      // stuck statement must not hold the connection open — and
      // release the connection only then. The probe makes the interrupted
      // pass exit cleanly; the next evaluation re-registers.
      deferDisconnect = true;
      prepAbandoned = true;
      conn.interrupt();
      const drain = setInterval(() => conn.interrupt(), REINTERRUPT_MS);
      registration
        .finally(() => {
          clearInterval(drain);
          conn.disconnectSync();
          staging.release();
          admission.release();
        })
        .catch(() => {});
      throw error;
    }

    // Engine statements: interrupt on the evaluation's own connection.
    let timedOut = false;
    let cancelled = false;
    let repeater: ReturnType<typeof setInterval> | undefined;
    const startInterrupting = () => {
      conn.interrupt();
      repeater ??= setInterval(() => conn.interrupt(), REINTERRUPT_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      startInterrupting();
    }, Math.max(deadline - Date.now(), 1));
    const onAbort = () => {
      cancelled = true;
      startInterrupting();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    // Same re-check as in preparation: a departure during the hand-off
    // between the two phases must not slip past its listener.
    if (signal?.aborted && !cancelled) onAbort();

    const bounds: EvaluationBounds = {
      interrupted: () => timedOut || cancelled,
      ...(bindings ? { bindings } : {}),
    };

    try {
      requireDatasetScope(scope, undefined, admission);
      staging.assertLive();
      const result = await fn(conn, bounds);
      staging.assertLive();
      requireDatasetScope(scope, undefined, admission);
      // The bound is wall-clock, not statements-only: a callback whose
      // engine work finished but whose tail (tile probes, archive reads)
      // outlived the budget or its caller does not return as a success.
      if (cancelled) throw new EvaluationCancelled();
      if (timedOut) throw timeoutError();
      return result;
    } catch (error) {
      // Once we interrupted the connection, whatever surfaced is our doing —
      // attribute it to the interruption, never to the user's SQL.
      if (cancelled) throw new EvaluationCancelled();
      if (timedOut) throw timeoutError();
      if (isOutOfMemory(error)) throw memoryError();
      throw normalizeEngineError(error);
    } finally {
      clearTimeout(timer);
      if (repeater) clearInterval(repeater);
      signal?.removeEventListener("abort", onAbort);
      foldEvaluation(collections, conn);
    }
  } finally {
    if (!deferDisconnect) { conn.disconnectSync(); staging.release(); admission.release(); }
  }
}
