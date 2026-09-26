/**
 * Waiting for a run to reach a terminal state.
 *
 * **A run outlives the request that started it**, so a surface watching one is
 * polling a resource rather than awaiting a response — and the two failure
 * modes that produces are both handled here rather than at each call site: a
 * poll that never stops because nothing is terminal, and a poll that keeps
 * running after the surface that wanted it is gone.
 *
 * There is deliberately no completion percentage to read (` `). What a caller
 * can honestly show is elapsed time, which is why this reports each reading
 * rather than only the last.
 */
export interface PollOptions<T> {
  read: () => Promise<T>;
  done: (value: T) => boolean;
  /** Reported for every reading, terminal or not. */
  onReading?: (value: T) => void;
  intervalMs?: number;
  /** How long to keep asking before giving up on the surface's behalf. The run
   * itself is unaffected — it is in the lane, and its outcome stays readable. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class PollAbandoned extends Error {
  constructor() {
    super(
      "This run is taking longer than expected. It is still running; its " +
        "outcome stays readable from the recipe.",
    );
    this.name = "PollAbandoned";
  }
}

export async function pollUntilTerminal<T>({
  read,
  done,
  onReading,
  intervalMs = 700,
  timeoutMs = 15 * 60 * 1000,
  signal,
}: PollOptions<T>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    onReading?.(value);
    if (done(value)) return value;
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (Date.now() > deadline) throw new PollAbandoned();
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  }
}
