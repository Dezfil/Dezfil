import { describe, it, expect, vi } from "vitest";
import {
  runOperationToCompletion,
  type RunState,
} from "./operation-run-client";

/**
 * Criterion 32's controlled arms: the run is held non-terminal, then completed,
 * then failed, deliberately. A generic smoke that saves something small would
 * never observe the non-terminal window at all — which is exactly the window
 * where a surface can look dead.
 */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A fake server that answers the accept, then a scripted run of poll states. */
function server(states: RunState[], final: Record<string, unknown> = {}) {
  const seen: string[] = [];
  let polls = 0;
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    seen.push(href);
    if (href.endsWith("/api/operations/run") && init?.method === "POST") {
      return json({ run: { id: "run-1", state: states[0] } });
    }
    const state = states[Math.min(polls + 1, states.length - 1)];
    polls += 1;
    return json({
      run: {
        id: "run-1",
        state,
        ...(state === "succeeded" ? { output: { id: "t1", name: "saved_name" } } : {}),
        ...final,
      },
    });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, seen, pollCount: () => polls };
}

describe("watching a run to completion", () => {
  it("stays busy across a genuinely non-terminal window, then reports the registered name", async () => {
    const observed: RunState[] = [];
    const { fetchImpl, pollCount } = server(["queued", "running", "running", "succeeded"]);

    const outcome = await runOperationToCompletion(
      { sql: "SELECT 1", name: "Requested Name" },
      { fetchImpl, pollMs: 1, onState: (s) => observed.push(s) },
    );

    // It really did observe a non-terminal run rather than a job that was
    // already finished when first read.
    expect(observed[0]).toBe("queued");
    expect(observed).toContain("running");
    expect(pollCount()).toBeGreaterThan(1);
    // And the name is the one the registry actually used, not what was typed.
    expect(outcome).toEqual({ ok: true, name: "saved_name" });
  });

  it("reports a failed run's coded reason", async () => {
    const { fetchImpl } = server(["running", "failed"], {
      error: { code: "sql_error", message: "Referenced column \"nope\" not found" },
    });
    const outcome = await runOperationToCompletion(
      { sql: "SELECT nope", name: "x" },
      { fetchImpl, pollMs: 1 },
    );
    expect(outcome).toEqual({
      ok: false,
      message: 'Referenced column "nope" not found',
    });
  });

  it("says so plainly when the run was cancelled", async () => {
    const { fetchImpl } = server(["running", "cancelled"]);
    const outcome = await runOperationToCompletion(
      { sql: "SELECT 1", name: "x" },
      { fetchImpl, pollMs: 1 },
    );
    expect(outcome).toEqual({ ok: false, message: "This run was cancelled." });
  });

  it("surfaces an admission refusal without polling at all", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ error: { code: "name_taken", message: "A table named \"x\" already exists." } }, 409),
    ) as unknown as typeof fetch;

    const outcome = await runOperationToCompletion(
      { sql: "SELECT 1", name: "x" },
      { fetchImpl, pollMs: 1 },
    );

    expect(outcome).toEqual({
      ok: false,
      message: 'A table named "x" already exists.',
    });
    // Refused before a run existed, so there was nothing to poll.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("survives a poll that fails rather than spinning forever", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (init?.method === "POST") return json({ run: { id: "r", state: "running" } });
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const outcome = await runOperationToCompletion(
      { sql: "SELECT 1", name: "x" },
      { fetchImpl, pollMs: 1 },
    );
    expect(outcome.ok).toBe(false);
    expect(calls).toBe(2);
  });

  it("stops watching when told to, without pretending the run stopped", async () => {
    const controller = new AbortController();
    const { fetchImpl } = server(["running", "running", "running", "running"]);
    const promise = runOperationToCompletion(
      { sql: "SELECT 1", name: "x" },
      { fetchImpl, pollMs: 5, signal: controller.signal },
    );
    controller.abort();
    const outcome = await promise;
    expect(outcome).toEqual({ ok: false, message: "Stopped watching this run." });
  });
});
