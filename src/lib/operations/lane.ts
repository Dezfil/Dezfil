import { ApiError } from "@/lib/api/errors";
import { limits } from "@/lib/limits";
import { onCommittedSettings } from "@/lib/settings/state";

/**
 * The operation run lane.
 *
 * Three properties carry it, and each exists because losing it would break
 * something a test that only reads job rows would not notice.
 *
 * **The slot is held until the work actually settles.** Cancelling aborts a
 * job's signal; it does not release the job's slot. The slot is released when
 * the work's promise settles, which — because the evaluation boundary keeps
 * interrupting the engine until its statement really stops — is when the engine
 * has really stopped. Releasing at the moment of cancellation instead would let
 * the lane admit new work against an instance still busy with the old, and the
 * concurrency cap would become a number the product no longer honours.
 *
 * **The queue is FIFO and bounded.** Admitted earlier means started earlier, and
 * a run arriving at a full queue is refused rather than accepted into a queue
 * that will not drain.
 *
 * **A job's cancellation source is its own.** It is never the HTTP request's:
 * the whole point of the lane is that work outlives the request that started
 * it, and passing the request's signal through is the one substitution that
 * silently undoes that.
 *
 * The lane is in-process and process-local, the same assumption the tile queue,
 * the refresh fence, the render slots and the in-flight reader set already make.
 */

/** Work the lane runs. It receives the job's own cancellation signal, and must
 * settle only once whatever it started has genuinely stopped. */
export type LaneWork = (signal: AbortSignal) => Promise<void>;

interface Entry {
  jobId: string;
  work: LaneWork;
  controller: AbortController;
  /** Resolves when this entry has left the lane, settled either way. */
  done: Promise<void>;
  release: () => void;
  started: boolean;
}

const key = Symbol.for("dezfil.operation-lane");
const host = globalThis as typeof globalThis & { [key]?: { waiting: Entry[]; inFlight: Map<string, Entry>; known: Map<string, Entry> } };
const holder = host[key] ??= { waiting: [] as Entry[], inFlight: new Map<string, Entry>(), known: new Map<string, Entry>() };
const { waiting, inFlight, known } = holder;

function queueFull(): ApiError {
  return new ApiError(
    "operation_queue_full",
    `${limits.operationQueueMax} operations are already waiting to run. ` +
      `Retry once some finish, or raise DEZFIL_OPERATION_QUEUE_MAX.`,
    503,
  );
}

/**
 * Admit a run, or refuse it because the queue is full.
 *
 * Admission is decided synchronously, before this returns, so a caller never
 * mints a job for work the lane declined. The work itself starts later — either
 * immediately, if a slot is free, or when one frees in arrival order.
 */
export function submit(jobId: string, work: LaneWork): void {
  if (known.has(jobId)) {
    throw new ApiError(
      "invalid_request",
      `Run "${jobId}" is already in the lane.`,
      409,
    );
  }
  if (inFlight.size >= limits.operationConcurrency && waiting.length >= limits.operationQueueMax) {
    throw queueFull();
  }

  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entry: Entry = {
    jobId,
    work,
    controller: new AbortController(),
    done,
    release,
    started: false,
  };
  known.set(jobId, entry);
  waiting.push(entry);
  pump();
}

function pump(): void {
  while (inFlight.size < limits.operationConcurrency && waiting.length > 0) {
    const entry = waiting.shift()!;
    // Cancelled while queued: it never starts, and its slot is never taken.
    if (entry.controller.signal.aborted) {
      known.delete(entry.jobId);
      entry.release();
      continue;
    }
    inFlight.set(entry.jobId, entry);
    entry.started = true;
    void execute(entry);
  }
}

onCommittedSettings("operation-lane", pump);

async function execute(entry: Entry): Promise<void> {
  try {
    await entry.work(entry.controller.signal);
  } catch {
    // The work owns its own outcome reporting; a throw here must not poison
    // the lane or become an unhandled rejection.
  } finally {
    // Only now — the work has settled, so whatever it was doing to the engine
    // has genuinely stopped. This is what keeps the concurrency cap honest.
    inFlight.delete(entry.jobId);
    known.delete(entry.jobId);
    entry.release();
    pump();
  }
}

/**
 * Ask the lane to stop a run.
 *
 * Returns whether the lane had it at all. A queued entry is fenced so it never
 * starts; a running one is signalled, and keeps its slot until it settles.
 * Reporting the job's terminal state is the caller's, not the lane's — the lane
 * knows about slots and signals, not about what a run means.
 */
export function cancel(jobId: string): boolean {
  const entry = known.get(jobId);
  if (!entry) return false;
  entry.controller.abort();
  if (!entry.started) {
    // Drop it out of the queue eagerly so a full queue frees immediately;
    // pump() also fences it, which covers a cancel landing mid-drain.
    const at = waiting.indexOf(entry);
    if (at >= 0) {
      waiting.splice(at, 1);
      known.delete(jobId);
      entry.release();
    }
  }
  return true;
}

/** Whether the lane is currently executing this run (not merely holding it). */
export function isExecuting(jobId: string): boolean {
  return inFlight.has(jobId);
}

/** Runs the lane holds, executing or waiting. */
export function laneDepth(): { executing: number; waiting: number } {
  return { executing: inFlight.size, waiting: waiting.length };
}

/** Resolve once this run has left the lane. Tests and journeys wait on it
 * rather than sleeping. */
export function jobSettled(jobId: string): Promise<void> {
  return known.get(jobId)?.done ?? Promise.resolve();
}

/** Resolve once the lane is empty. */
export async function laneSettled(): Promise<void> {
  while (known.size > 0) {
    await Promise.all([...known.values()].map((e) => e.done));
    // Let finally-handlers run so follow-on work enters the lane.
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Tests reset shared state. */
export function resetLane(): void {
  for (const entry of known.values()) {
    entry.controller.abort();
    entry.release();
  }
  waiting.length = 0;
  inFlight.clear();
  known.clear();
}

export async function eraseLaneWork(ids: readonly string[]): Promise<void> {
  const work = ids.map(jobSettled); for (const id of ids) cancel(id); await Promise.all(work);
}
export function laneEntriesForTests() { return { waiting: waiting.map(e => e.jobId), inFlight: [...inFlight.keys()], known: [...known.keys()] }; }
