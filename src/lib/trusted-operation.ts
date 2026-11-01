import { StorageWriter } from "./system/storage-fence";
import { AsyncLocalStorage } from "node:async_hooks";
import { ApiError, EvaluationCancelled, type ErrorCode } from "./api/errors";
import { RESOURCE_ERROR_STATUSES } from "./api/error-catalogue";
import { limits } from "./limits";
import { settingRemedy } from "./settings/remedy";

export const TRUSTED_SETTLEMENT_MS = 35_000;

/** The operation, rather than a connection or nested helper, owns the policy. */
export const TRUSTED_OPERATION_POLICIES = {
  "interactive-read": { budget: "query", departure: "cancel" },
  export: { budget: "processing", departure: "cancel" },
  import: { budget: "processing", departure: "continue" },
  refresh: { budget: "processing", departure: "continue" },
  "template-install": { budget: "processing", departure: "continue" },
  "geometry-change": { budget: "processing", departure: "continue" },
  "sketch-change": { budget: "processing", departure: "continue" },
} as const;
export type TrustedOperationKind = keyof typeof TRUSTED_OPERATION_POLICIES;

export interface TrustedOperationOptions {
  kind: TrustedOperationKind;
  name: string;
  signal?: AbortSignal;
  /** An already captured budget, for the reception-to-processing handoff. */
  budgetMs?: number;
  /** A shared child keeps the original absolute deadline and admitted limit. */
  deadline?: number;
  /** Interests are parent-operation signals; stop when none still needs this child. */
  shared?: boolean;
  /** Small recovery work, such as deleting a sketch, creates no dataset. */
  storage?: boolean;
}

/** Keep every already-coded refusal intact through source-specific wrappers,
 * including shorter source limits and hardened-engine validation failures. */
export function isTrustedOperationRefusal(error: unknown): error is ApiError | EvaluationCancelled {
  return error instanceof ApiError || error instanceof EvaluationCancelled;
}

const LIFETIME_OUTCOMES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "query_timeout", "data_processing_timeout", "request_timeout", "upload_stalled", "remote_timeout",
  "operation_timeout", "render_timeout", "tile_build_timeout", "engine_memory_exceeded", "query_memory_exceeded",
]);

/** Outcomes that end the whole operation whatever a wrapper makes of them
 * later: its deadline and every shorter time limit, a departed caller, and
 * engine memory or scratch. Any other error belongs to the code that catches
 * it, which may translate it, as a refresh does with a source table that is
 * gone; it becomes the operation's outcome only by reaching its root. */
export function isLifetimeOutcome(error: unknown): error is ApiError | EvaluationCancelled {
  return error instanceof EvaluationCancelled || (error instanceof ApiError && LIFETIME_OUTCOMES.has(error.code));
}

export function trustedMemoryRefusal(name: string, resource: "memory" | "scratch", memoryMb = limits.trustedMemoryMb): ApiError {
  const budget = resource === "scratch" ? memoryMb * 4 : memoryMb;
  return new ApiError("engine_memory_exceeded",
    `${name} exceeded the ${budget} MB ${resource} budget shared by trusted data work. Reduce the work, or raise DEZFIL_TRUSTED_MEMORY_MB and restart.`,
    RESOURCE_ERROR_STATUSES.engine_memory_exceeded);
}

/** An overdue settlement is an owner failure, never a replacement for the
 * refusal or success already returned. The owner can still await drained for
 * late cleanup. */
export class TrustedSettlementOverdue extends Error {
  readonly allowanceMs = TRUSTED_SETTLEMENT_MS;
  constructor(name: string, cause: unknown, after: "refusal" | "commit" = "refusal") {
    super(`${name} did not settle within ${TRUSTED_SETTLEMENT_MS / 1000} s of its ${after}.`, { cause });
  }
}

const context = new AsyncLocalStorage<TrustedOperation>();
export function currentTrustedOperation(): TrustedOperation | undefined { return context.getStore(); }
const observe = (promise: Promise<unknown>) => { void promise.catch(() => {}); };

/** Admit synchronously before queueing, preparing a source or starting an
 * engine. run owns the root callback, stop hooks and cleanup. A rejected run
 * may still own native work: settled reports cleanup (or an overdue owner),
 * while drained waits for actual completion even after the allowance expires.
 * Native/source owners must act on signal or onStop; a timer cannot kill them.
 */
export class TrustedOperation {
  readonly admittedAt = performance.now();
  readonly budgetMs: number;
  readonly deadline: number;
  readonly signal: AbortSignal;
  readonly kind: TrustedOperationKind;
  readonly name: string;
  private decisionTime: number | null = null;
  private commitTime: number | null = null;
  get decidedAt(): number | null { return this.decisionTime; }
  /** Whether the last interested caller's departure refuses this work. */
  get cancelsOnDeparture(): boolean { return this.policy.departure === "cancel"; }
  get settlementDeadline(): number | null { return this.decisionTime === null ? null : this.decisionTime + TRUSTED_SETTLEMENT_MS; }
  private readonly controller = new AbortController();
  private readonly policy: { budget: "query" | "processing"; departure: "cancel" | "continue" };
  private readonly stopped = Promise.withResolvers<never>();
  private readonly settlement = Promise.withResolvers<void>();
  private readonly drain = Promise.withResolvers<void>();
  /** Resolves when committed work's cleanup outlasts the settlement allowance. */
  private readonly commitOverdue = Promise.withResolvers<TrustedSettlementOverdue>();
  readonly settled = this.settlement.promise;
  readonly drained = this.drain.promise;
  private failure: unknown;
  private started = false;
  private complete = false;
  private stage: string;
  private readonly remedy: string;
  private deadlineTimer?: ReturnType<typeof setTimeout>;
  private settlementTimer?: ReturnType<typeof setTimeout>;
  private readonly interests = new Set<() => void>();
  private readonly stopHooks = new Set<() => void>();
  private readonly cleanups: (() => void | Promise<void>)[] = [];
  private readonly cleanupErrors: unknown[] = [];
  private readonly commitListeners = new Set<() => void>();

  constructor(options: TrustedOperationOptions) {
    this.kind = options.kind; this.name = options.name;
    this.policy = { ...TRUSTED_OPERATION_POLICIES[options.kind], ...(options.shared ? { departure: "cancel" as const } : {}) };
    this.budgetMs = options.budgetMs ?? (this.policy.budget === "query" ? limits.queryTimeoutMs : limits.dataProcessingTimeoutMs);
    if (!Number.isFinite(this.budgetMs) || this.budgetMs <= 0) throw new RangeError("An operation budget must be positive and finite.");
    if (options.deadline !== undefined && !Number.isFinite(options.deadline)) throw new RangeError("An operation deadline must be finite.");
    this.deadline = Math.min(this.admittedAt + this.budgetMs, options.deadline ?? Infinity);
    this.stage = this.policy.budget;
    this.remedy = settingRemedy(this.policy.budget === "query" ? "queryTimeoutS" : "dataProcessingTimeoutS");
    this.signal = this.controller.signal;
    observe(this.stopped.promise); observe(this.settled);
    this.armDeadline();
    this.join(options.signal);
  }

  private timeout(): ApiError {
    const code = this.policy.budget === "query" ? "query_timeout" : "data_processing_timeout";
    return new ApiError(code, `${this.name} exceeded the ${this.budgetMs / 1000} s ${this.stage} time limit. ${this.remedy}`, 408);
  }

  private armDeadline(): void {
    // Large deployment values must not overflow Node's timer into a 1 ms timer.
    this.deadlineTimer = setTimeout(() => {
      if (performance.now() >= this.deadline) this.refuse(this.timeout());
      else this.armDeadline();
    }, Math.min(2_147_483_647, Math.max(0, this.deadline - performance.now())));
    this.deadlineTimer.unref?.();
  }

  private check(): void {
    if (this.decidedAt !== null) throw this.failure;
    if (this.complete) throw new Error("This operation has settled.");
    if (this.commitTime === null && performance.now() >= this.deadline) { this.refuse(this.timeout()); throw this.failure; }
  }

  /** Call immediately before the synchronous commit, after all asynchronous
   * preparation and the existing permission, identity and revision checks. */
  assertCanCommit(): void { this.check(); }

  enterStage(stage: string): void { this.stage = stage; this.check(); }

  /** Each interested caller holds one independent lease. Removing the last
   * lease cancels only a cancellable operation; joining never renews time. */
  join(signal?: AbortSignal): () => void {
    this.check();
    let left = false;
    const detach = () => { signal?.removeEventListener("abort", leave); this.interests.delete(detach); };
    const leave = () => {
      if (left) return;
      left = true; detach();
      if (!this.complete && this.interests.size === 0 && this.policy.departure === "cancel") this.refuse(new EvaluationCancelled());
    };
    this.interests.add(detach);
    signal?.addEventListener("abort", leave, { once: true });
    if (signal?.aborted) leave();
    return leave;
  }

  /** A connection/source acquired after refusal is stopped immediately too.
   * Release the hook when that resource ends so it cannot interrupt reuse. */
  onStop(stop: () => void): () => void {
    if (this.complete) throw new Error("This operation has settled.");
    if (this.decidedAt !== null) this.stopResource(stop);
    else this.stopHooks.add(stop);
    return () => { this.stopHooks.delete(stop); };
  }

  /** Cleanup begins only after the root work actually stops using resources. */
  defer(cleanup: () => void | Promise<void>): void {
    if (this.complete) throw new Error("This operation has settled.");
    this.cleanups.push(cleanup);
  }

  private stopResource(stop: () => void): void {
    try { stop(); } catch (error) { this.cleanupErrors.push(error); }
  }

  /** For a catch block that rethrows: a lifetime outcome ends the operation
   * now, and any other error is left to the caller to translate. */
  refuseIfFinal(error: unknown): void { if (isLifetimeOutcome(error)) this.refuse(error); }

  /** First decision wins, including coded refusals from a shorter boundary.
   * Committed work has already decided: its answer is the success. */
  refuse(error: unknown): void {
    if (this.decidedAt !== null || this.complete || this.commitTime !== null) return;
    this.failure = error;
    this.decisionTime = performance.now();
    clearTimeout(this.deadlineTimer);
    this.settlementTimer = setTimeout(() => {
      this.settlement.reject(new TrustedSettlementOverdue(this.name, this.failure));
    }, TRUSTED_SETTLEMENT_MS);
    this.settlementTimer.unref?.();
    this.stopped.reject(error);
    this.controller.abort(error);
    for (const stop of this.stopHooks) this.stopResource(stop);
    this.stopHooks.clear();
  }

  /** For a source that enforces this operation's remaining time itself: its
   * expiry is this operation's own time limit. Decides the operation with
   * that refusal and returns the answer to throw. */
  refuseAtDeadline(): unknown {
    const refusal = this.timeout(); this.refuse(refusal);
    return this.decidedAt !== null ? this.failure : refusal;
  }

  /** Call right after the work's final synchronous commit. From then on the
   * answer is that success: the deadline is disarmed, and no later deadline,
   * departure or refusal can replace it. The remaining cleanup is still owned
   * until it drains. The answer waits for it within the settlement allowance
   * and no longer; an overdue one is reported through settled and logged
   * once, never through the answer. Callers waiting on this work as shared
   * work are committed with it. */
  markCommitted(): void {
    if (!this.commit()) return;
    for (const listener of this.commitListeners) listener();
    this.commitListeners.clear();
  }

  /** Runs the listener when this work commits, at once if it already has. */
  onCommitted(listener: () => void): () => void {
    if (this.commitTime !== null) { listener(); return () => {}; }
    this.commitListeners.add(listener);
    return () => { this.commitListeners.delete(listener); };
  }

  private commit(): boolean {
    if (this.commitTime !== null || this.decidedAt !== null || this.complete) return false;
    this.commitTime = performance.now();
    clearTimeout(this.deadlineTimer);
    this.settlementTimer = setTimeout(() => {
      const overdue = new TrustedSettlementOverdue(this.name, undefined, "commit");
      this.settlement.reject(overdue); this.commitOverdue.resolve(overdue);
    }, TRUSTED_SETTLEMENT_MS);
    this.settlementTimer.unref?.();
    return true;
  }

  /** Nested helpers keep the original owner even when they request a read
   * policy inside an accepted mutation, or are handed its departed signal.
   * Only a lifetime outcome decides here; the root decides anything else. */
  async within<T>(work: (operation: TrustedOperation) => Promise<T>): Promise<T> {
    this.check();
    try {
      const value = await context.run(this, () => work(this));
      this.check(); return value;
    } catch (error) {
      this.refuseIfFinal(error);
      if (this.decidedAt !== null) throw this.failure;
      throw error;
    }
  }

  run<T>(work: (operation: TrustedOperation) => Promise<T>): Promise<T> {
    if (this.started) throw new Error("An operation runs only once.");
    this.started = true;
    let answered = false;
    const running = Promise.resolve().then(() => this.within(work)).then(value => {
      // Resolved work is a success whatever its cleanup does afterwards.
      this.commit(); answered = true; return value;
    }, error => {
      this.refuse(error); throw this.decidedAt !== null ? this.failure : error;
    });
    const finished = running.finally(async () => {
      // A cleanup failure must not prevent another resource from being released.
      while (this.cleanups.length) {
        try { await this.cleanups.pop()!(); } catch (error) { this.cleanupErrors.push(error); }
      }
      for (const detach of this.interests) detach();
      this.stopHooks.clear(); this.commitListeners.clear();
      clearTimeout(this.deadlineTimer);
      clearTimeout(this.settlementTimer);
      this.complete = true;
      if (this.cleanupErrors.length) {
        const error = new AggregateError(this.cleanupErrors, `${this.name} cleanup failed.`, { cause: this.failure });
        this.settlement.reject(error); this.drain.resolve();
        // Committed work keeps its answer; the failure is reported through
        // settled and, since no caller sees it, in the server log.
        if (this.commitTime === null) throw error;
        if (answered) console.warn(`Trusted ${this.kind} cleanup failed after its commit`, error);
        return;
      }
      this.settlement.resolve(); this.drain.resolve();
    });
    observe(finished);
    // A committed value waits for its cleanup, but no longer than the
    // settlement allowance: the caller gets the success then, the overdue
    // cleanup is logged once, since no caller sees it, and the operation
    // keeps owning that cleanup until drained.
    const answer = running.then(value => Promise.race([
      finished.then(() => value),
      this.commitOverdue.promise.then(overdue => {
        console.warn(`Trusted ${this.kind} cleanup overdue after its commit`, overdue);
        return value;
      }),
    ]));
    return Promise.race([answer, this.stopped.promise]);
  }
}

export function admitTrustedOperation(options: TrustedOperationOptions): TrustedOperation {
  const writes = options.storage ?? options.kind !== "interactive-read";
  let operation: TrustedOperation;
  const writer = writes ? new StorageWriter(error => operation.refuse(error)) : undefined;
  try { operation = new TrustedOperation(options); }
  catch (error) { writer?.close(); throw error; }
  if (writer) void operation.drained.then(() => writer.close());
  return operation;
}

export function withTrustedOperation<T>(options: TrustedOperationOptions, work: (operation: TrustedOperation) => Promise<T>): Promise<T> {
  const inherited = currentTrustedOperation();
  return inherited ? inherited.within(work) : admitTrustedOperation(options).run(work);
}
