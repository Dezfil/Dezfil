"use client";

import { useEffect, useMemo, useState } from "react";
import { WorkflowDocument } from "./workflow-document";
import { editHeaders } from "@/lib/edit-basis";
import { readApiFailure } from "../api";
import { serverUnreachable } from "../failure-copy";
import type { EditOutcome } from "./use-recipe-edits";
import { mergeRun, type WorkflowRun } from "./run-overlay";

/**
 * The workflow's runs, owned in one place: the newest hundred as the API
 * lists them, the run in flight discovered from that list or started
 * here, polled for as long as it lives — no more than two seconds between
 * completed reads, never abandoned by a timer — and every answer merged
 * into the list, so the tiles, the dock and the Messages log have one
 * live source. Every start goes through the pre-run barrier first: what
 * is typed lands, every canvas-origin change still in flight is awaited,
 * and a refused or failed save starts nothing.
 */

export type RunPhase = "idle" | "starting" | "running" | "cancelling" | "settling";

export interface RunPlan {
  editRevision?: string;
  kind: "run_all" | "from_step";
  wide: boolean;
  members: string[];
}

export type StartOutcome =
  | { kind: "started"; run: WorkflowRun }
  /** The API's refusal; `retryable` when a retry can succeed (the lane, the
   * network). The caller that owns the refusal owns its Retry. */
  | { kind: "refused"; code: string; message: string; retryable: boolean }
  | { kind: "save_failed"; message: string }
  | { kind: "nothing_to_run" };

export interface WorkflowRunState {
  runs: WorkflowRun[];
  /** The run in flight, or the run whose outcome is still being shown. */
  active: WorkflowRun | null;
  phase: RunPhase;
  /** The last run to end, until the next starts: the outcome line's. */
  ended: WorkflowRun | null;
  /** A read that could not be made: the last state stays, Retry resumes. */
  readFailure: { message: string; retry: () => void } | null;
  /** Whether the overlay is still worn: until the post-run reads land. */
  overlaid: boolean;
}

export interface WorkflowRunner {
  state: WorkflowRunState;
  plan: (fromStepId?: string) => Promise<RunPlan | { refused: string }>;
  start: (request: { fromStepId?: string; members?: string[]; editRevision?: string }) => Promise<StartOutcome>;
  runNode: (stepId: string) => Promise<StartOutcome>;
  cancel: () => Promise<void>;
  /** Whether a member of the run in flight has not settled. */
  unsettled: (stepId: string) => boolean;
  /** The panel's flush, registered while it is open: what is typed lands first. */
  setFlush: (flush: (() => Promise<EditOutcome | null>) | null) => void;
  /** Land what the open panel holds, now (a copy reads what the panel shows). */
  flushPanel: () => Promise<EditOutcome | null>;
  /** The open panel's draft as it stands, registered while it is open: the values a copy carries. */
  setDraft: (read: (() => PanelDraft | null) | null) => void;
  panelDraft: () => PanelDraft | null;
  /** Re-read the runs and adopt one in flight: a run something else
   * started (an assistant action resolved here). */
  observe: () => Promise<WorkflowRun | null>;
}

/** What the panel shows for editing: its values, or why they cannot be saved as they stand. */
export interface PanelDraft {
  values: Record<string, unknown>;
  invalid: string | null;
}

interface Ports {
  /** Every canvas-origin change still in flight, awaited before a start;
   * answers the last one refused or failed, so nothing starts over it. */
  settle: () => Promise<EditOutcome | null>;
  /** Re-read; true when the read landed. */
  onRecipeChanged: () => Promise<boolean>;
  onTablesChanged: () => Promise<boolean>;
  onRunSeen: (run: WorkflowRun) => void;
}

const POLL_MS = 1000;

const terminal = (run: WorkflowRun) => run.outcome !== null;

type Answer = { ok: true; body: unknown } | { ok: false; refused: { code: string; message: string } } | { ok: false; failed: string; unreadable?: boolean };

async function call(path: string, init: RequestInit, action: string, request: typeof fetch = fetch): Promise<Answer> {
  let response: Response;
  try {
    response = await request(path, { ...init, headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(init.headers)) }, cache: "no-store" });
  } catch {
    return { ok: false, failed: serverUnreachable(action) };
  }
  if (response.ok) {
    try { return { ok: true, body: response.status === 204 ? null : await response.json() }; }
    catch { return { ok: false, failed: "Couldn't read the response.", unreadable: true }; }
  }
  return { ok: false, refused: await readApiFailure(response) };
}

function refusalOf(result: Answer & { ok: false }): StartOutcome {
  if ("failed" in result) return { kind: "refused", code: "unreachable", message: result.failed, retryable: true };
  return { kind: "refused", code: result.refused.code, message: result.refused.message, retryable: result.refused.code === "operation_queue_full" };
}

class Runner implements WorkflowRunner {
  state: WorkflowRunState = { runs: [], active: null, phase: "idle", ended: null, readFailure: null, overlaid: false };
  private generation = 0;
  private disposed = false;
  private lifetime = 0;
  private observation: AbortController | null = null;
  private wake: (() => void) | null = null;

  private beginObservation(): number {
    this.observation?.abort();
    this.wake?.();
    this.observation = new AbortController();
    return ++this.generation;
  }
  dispose = () => {
    this.disposed = true;
    ++this.lifetime;
    ++this.generation;
    this.observation?.abort();
    this.wake?.();
  };
  private wait(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        if (this.wake === done) this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, POLL_MS);
      this.wake = done;
    });
  }
  private flush: (() => Promise<EditOutcome | null>) | null = null;
  private listeners = new Set<() => void>();

  constructor(
    private readonly id: string,
    private ports: Ports,
    private document = new WorkflowDocument(id),
  ) {}

  setPorts(ports: Ports) {
    this.ports = ports;
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private set(patch: Partial<WorkflowRunState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }
  setFlush = (flush: (() => Promise<EditOutcome | null>) | null) => {
    this.flush = flush;
  };
  flushPanel = (): Promise<EditOutcome | null> => (this.flush ? this.flush() : Promise.resolve(null));
  private draft: (() => PanelDraft | null) | null = null;
  setDraft = (read: (() => PanelDraft | null) | null) => {
    this.draft = read;
  };
  panelDraft = (): PanelDraft | null => (this.draft ? this.draft() : null);
  observe = () => this.load();
  unsettled = (stepId: string) => {
    const run = this.state.active;
    if (!run || terminal(run) || !this.state.overlaid) return false;
    const m = run.members.find((x) => x.stepId === stepId);
    return !!m && (m.state === "pending" || m.state === "running");
  };

  /** The runs list, and the run in flight found in it. */
  load = async () => {
    this.disposed = false;
    const gen = this.beginObservation();
    const result = await call(`/api/recipes/${this.id}/runs`, { method: "GET", signal: this.observation?.signal }, "read the workflow's runs");
    if (gen !== this.generation) return null;
    if (!result.ok) {
      this.set({ readFailure: { message: "failed" in result ? result.failed : result.refused.message, retry: () => { if (gen === this.generation) void this.load(); } } });
      return null;
    }
    const runs = (result.body as { runs: WorkflowRun[] }).runs;
    const active = runs.find((r) => !terminal(r)) ?? null;
    this.set({ runs, readFailure: null });
    if (active) {
      this.set({ active, phase: "running", overlaid: true, ended: null });
      this.ports.onRunSeen(active);
      void this.poll(active.id, gen);
    }
    return active;
  };

  /** Follow one run to its outcome, merging every answer; keep the overlay
   * until the post-run reads land. */
  private async poll(runId: string, gen: number) {
    let last: WorkflowRun | null = this.state.active;
    for (;;) {
      if (gen !== this.generation) return;
      const result = await call(`/api/recipes/${this.id}/runs/${runId}`, { method: "GET", signal: this.observation?.signal }, "read the run");
      if (gen !== this.generation) return;
      if (!result.ok) {
        const message = "failed" in result ? result.failed : result.refused.message;
        this.set({ readFailure: { message, retry: () => { if (gen === this.generation) void this.poll(runId, this.beginObservation()); } } });
        return;
      }
      const run = (result.body as { run: WorkflowRun }).run;
      const changed = !last || run.members.some((m, i) => {
        const was = last!.members[i];
        return !was || was.state !== m.state || was.attempt?.state !== m.attempt?.state;
      });
      const succeededNow = last
        ? run.members.some((m) => m.state === "succeeded" && last!.members.find((x) => x.stepId === m.stepId)?.state !== "succeeded")
        : run.members.some((m) => m.state === "succeeded");
      this.set({ runs: mergeRun(this.state.runs, run), active: run, readFailure: null });
      if (terminal(run)) {
        this.set({ phase: "settling" });
        await this.settleAfter(run, gen);
        return;
      }
      if (changed) {
        void this.ports.onRecipeChanged();
        if (succeededNow) void this.ports.onTablesChanged();
      }
      last = run;
      await this.wait();
    }
  }

  /** The tiles keep the run's words until the recipe and the tables say
   * what stands after it; a read that does not land keeps
   * the overlay and offers Retry. */
  private async settleAfter(run: WorkflowRun, gen: number) {
    const [recipe, tables] = await Promise.all([this.ports.onRecipeChanged(), this.ports.onTablesChanged()]);
    if (gen !== this.generation) return;
    if (!recipe || !tables) {
      this.set({
        readFailure: {
          message: serverUnreachable("read the workflow after the run"),
          retry: () => {
            if (gen !== this.generation) return;
            this.set({ readFailure: null });
            void this.settleAfter(run, this.generation);
          },
        },
      });
      return;
    }
    this.set({ phase: "idle", ended: run, active: null, overlaid: false, readFailure: null });
    await this.refreshList(gen);
  }

  private async refreshList(gen: number) {
    const result = await call(`/api/recipes/${this.id}/runs`, { method: "GET", signal: this.observation?.signal }, "read the workflow's runs");
    if (gen !== this.generation || !result.ok) return;
    this.set({ runs: (result.body as { runs: WorkflowRun[] }).runs });
  }

  plan = async (fromStepId?: string): Promise<RunPlan | { refused: string }> => {
    const blocked = await this.barrier();
    if (blocked && "message" in blocked) return { refused: blocked.kind === "save_failed" ? `Couldn't save the change, so nothing started. ${blocked.message}` : blocked.message };
    return this.document.enqueue(async () => {
      const result = await call(`/api/recipes/${this.id}/runs`,
        { method: "POST", body: JSON.stringify({ plan: true, ...(fromStepId ? { fromStepId } : {}) }) }, "plan the run");
      if (!result.ok) return { refused: "failed" in result ? result.failed : result.refused.message };
      const body = result.body as { plan: RunPlan; editRevision?: string };
      return { ...body.plan, ...(body.editRevision ? { editRevision: body.editRevision } : {}) };
    });
  };

  /** The pre-run barrier: what is typed lands, everything in flight is
   * awaited; a refused or failed save starts nothing. */
  private async barrier(): Promise<StartOutcome | null> {
    if (this.flush) {
      const outcome = await this.flush();
      if (outcome && (outcome.kind === "refused" || outcome.kind === "failed")) {
        return { kind: "save_failed", message: outcome.message };
      }
    }
    // Everything else on the wire — an edit whose debounce already fired,
    // an add, a discard, a removal — and its answer.
    const rejected = await this.ports.settle();
    if (rejected && (rejected.kind === "refused" || rejected.kind === "failed")) return { kind: "save_failed", message: rejected.message };
    return null;
  }

  private adopt(run: WorkflowRun) {
    if (this.disposed) return;
    const gen = this.beginObservation();
    this.set({ active: run, phase: "running", overlaid: true, ended: null, runs: mergeRun(this.state.runs, run), readFailure: null });
    this.ports.onRunSeen(run);
    void this.ports.onRecipeChanged();
    void this.poll(run.id, gen);
  }

  private closedStart(lifetime: number): StartOutcome | null {
    return this.disposed || lifetime !== this.lifetime
      ? { kind: "refused", code: "screen_closed", message: "The workflow was closed before the action finished.", retryable: false }
      : null;
  }

  private async finishStart(result: Answer, lifetime: number): Promise<StartOutcome> {
    const closed = this.closedStart(lifetime);
    if (closed) return closed;
    if (!result.ok) {
      if ("unreadable" in result && result.unreadable) {
        const run = await this.load();
        const closed = this.closedStart(lifetime);
        if (closed) return closed;
        if (run) return { kind: "started", run };
        this.set({ phase: this.state.active ? "running" : "idle" });
        return { kind: "refused", code: "unconfirmed_start", message: "Couldn't confirm the run started.", retryable: true };
      }
      this.set({ phase: this.state.active ? "running" : "idle" });
      return refusalOf(result);
    }
    const run = (result.body as { run: WorkflowRun }).run;
    this.adopt(run);
    return { kind: "started", run };
  }

  start = async (request: { fromStepId?: string; members?: string[]; editRevision?: string }): Promise<StartOutcome> => {
    const lifetime = this.lifetime;
    const blocked = await this.barrier();
    const closed = this.closedStart(lifetime);
    if (closed) return closed;
    if (blocked) return blocked;
    this.set({ phase: "starting" });
    const { editRevision, ...input } = request;
    const result = await this.document.enqueue(() => call(`/api/recipes/${this.id}/runs`, { method: "POST", headers: editRevision ? editHeaders({ editRevision }) : this.document.headers(), body: JSON.stringify(input) }, "start the run"));
    return this.finishStart(result, lifetime);
  };

  runNode = async (stepId: string): Promise<StartOutcome> => {
    const lifetime = this.lifetime;
    const blocked = await this.barrier();
    const closed = this.closedStart(lifetime);
    if (closed) return closed;
    if (blocked) return blocked;
    this.set({ phase: "starting" });
    const result = await this.document.enqueue(() => call(`/api/recipes/${this.id}/steps/${stepId}/run`, { method: "POST", headers: this.document.headers() }, "run the node"));
    return this.finishStart(result, lifetime);
  };

  cancel = async () => {
    const run = this.state.active;
    if (!run || terminal(run)) return;
    this.set({ phase: "cancelling" });
    const result = await call(`/api/recipes/${this.id}/runs/${run.id}/cancel`, { method: "POST" }, "cancel the run");
    if (!result.ok) {
      this.set({ phase: "running", readFailure: { message: "failed" in result ? result.failed : result.refused.message, retry: () => void this.cancel() } });
      return;
    }
    // The answer is the record after the cancel; the poll carries it home.
    const after = (result.body as { run: WorkflowRun }).run;
    this.set({ runs: mergeRun(this.state.runs, after) });
  };
}

export function useWorkflowRun(id: string, ports: Ports, document?: WorkflowDocument): WorkflowRunner {
  const runner = useMemo(() => new Runner(id, ports, document), [id, document]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    runner.setPorts(ports);
  }, [runner, ports]);
  const [, bump] = useState(0);
  useEffect(() => runner.subscribe(() => bump((n) => n + 1)), [runner]);
  useEffect(() => {
    void runner.load();
    return runner.dispose;
  }, [runner]);
  return runner;
}
