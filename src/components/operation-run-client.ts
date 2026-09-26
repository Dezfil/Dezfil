/**
 * Driving one operation run from a browser surface.
 *
 * Since a run answers `202` before the work is done, so every surface that
 * saves a result has to accept a run and then watch it. That watching is here
 * rather than inside a component for two reasons: it is the part with
 * behaviour worth testing, and the drawer will need exactly the same loop.
 *
 * **The busy state has no gap.** The caller is told the work has begun before
 * the accept request is even sent, and told nothing else until the run reaches
 * a terminal state. A surface that only became busy once the `202` came back
 * would show a dead interval on the press, which is the moment a user is most
 * likely to press again.
 */

export type RunState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface RunView {
  id: string;
  state: RunState;
  output?: { id: string; name: string };
  error?: { code: string; message: string };
}

export type RunOutcome =
  | { ok: true; name: string }
  | { ok: false; message: string };

export interface RunOptions {
  /** Poll cadence. Short enough to feel immediate, long enough not to hammer. */
  pollMs?: number;
  /** Injected for tests; defaults to the global. */
  fetchImpl?: typeof fetch;
  /** Called on every state the run passes through, for the busy copy. */
  onState?: (state: RunState) => void;
  /** Stop watching (the surface unmounted). Does not cancel the run itself —
   * the run outliving its watcher is the point of the lane. */
  signal?: AbortSignal;
}

const TERMINAL: RunState[] = ["succeeded", "failed", "cancelled"];

function failed(message: string): RunOutcome {
  return { ok: false, message };
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Start a run and watch it to a terminal state.
 *
 * Resolves with the registered name, or with the coded reason it failed —
 * never throws for an ordinary refusal, because every one of those is
 * something the user needs to read.
 */
export async function runOperationToCompletion(
  parameters: { sql: string; name: string },
  options: RunOptions = {},
): Promise<RunOutcome> {
  const doFetch = options.fetchImpl ?? fetch;
  const pollMs = options.pollMs ?? 400;

  let accepted: Response;
  try {
    accepted = await doFetch("/api/operations/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "sql_step", parameters }),
    });
  } catch {
    return failed("The dataset could not be saved.");
  }

  if (!accepted.ok) {
    // Everything refused at admission — a taken name, SQL the guard rejects,
    // a full queue — arrives here, already worded for a human.
    return failed(await readError(accepted, "The dataset could not be saved."));
  }

  let run: RunView;
  try {
    run = ((await accepted.json()) as { run: RunView }).run;
  } catch {
    return failed("The dataset could not be saved.");
  }
  options.onState?.(run.state);

  while (!TERMINAL.includes(run.state)) {
    if (options.signal?.aborted) return failed("Stopped watching this run.");
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    if (options.signal?.aborted) return failed("Stopped watching this run.");

    let polled: Response;
    try {
      polled = await doFetch(`/api/operations/runs/${encodeURIComponent(run.id)}`);
    } catch {
      return failed("Lost contact with the run. Check the run list.");
    }
    if (!polled.ok) {
      return failed(await readError(polled, "The run could not be read."));
    }
    try {
      run = ((await polled.json()) as { run: RunView }).run;
    } catch {
      return failed("The run could not be read.");
    }
    options.onState?.(run.state);
  }

  if (run.state === "succeeded" && run.output) {
    // The registered name, not the requested one: a name is sanitized into a
    // SQL identifier, and reporting what the user typed sends them looking for
    // a table that does not exist.
    return { ok: true, name: run.output.name };
  }
  if (run.state === "cancelled") return failed("This run was cancelled.");
  return failed(run.error?.message ?? "The dataset could not be saved.");
}
