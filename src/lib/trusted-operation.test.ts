import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, EvaluationCancelled, errorResponse } from "./api/errors";
import { ERROR_CATALOGUE, RESOURCE_ERROR_STATUSES } from "./api/error-catalogue";
import { buildOpenApiDocument } from "./api/openapi";
import { limits } from "./limits";
import {
  admitTrustedOperation, currentTrustedOperation, isLifetimeOutcome, isTrustedOperationRefusal,
  trustedMemoryRefusal, withTrustedOperation, TrustedSettlementOverdue, type TrustedOperation,
} from "./trusted-operation";
import { withTrustedMutation } from "./trusted-mutation";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const held = <T = void>() => Promise.withResolvers<T>();
const read = (signal?: AbortSignal, budgetMs = 1000) => admitTrustedOperation({ kind: "interactive-read", name: "Dataset inspection", signal, budgetMs });
const observed = <T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> => promise.then(value => ({ value }), error => ({ error }));

it("admits before queue wait and never starts work whose place arrives expired", async () => {
  const op = read();
  const queue = held();
  const work = vi.fn();
  const result = observed(op.run(async () => { await queue.promise; op.assertCanCommit(); work(); }));
  await vi.advanceTimersByTimeAsync(1000);
  expect(await result).toMatchObject({ error: { code: "query_timeout", status: 408 } });
  expect(op.decidedAt).toBe(op.deadline);
  queue.resolve();
  await op.settled;
  expect(work).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("charges time between admission and run, including a delayed timer callback", async () => {
  const now = vi.spyOn(performance, "now").mockReturnValue(100);
  const op = read();
  now.mockReturnValue(1100);
  const work = vi.fn(async () => 1);
  await expect(op.run(work)).rejects.toMatchObject({ code: "query_timeout" });
  await op.settled;
  expect(work).not.toHaveBeenCalled();
});

it("inherits one deadline, budget and departure policy through nested helpers", async () => {
  const caller = new AbortController();
  const op = admitTrustedOperation({ kind: "import", name: "File import", signal: caller.signal, budgetMs: 1000 });
  const result = op.run(async () => {
    await vi.advanceTimersByTimeAsync(400);
    caller.abort();
    return withTrustedOperation({ kind: "interactive-read", name: "Sketch helper", budgetMs: 999999, signal: caller.signal }, async child => {
      expect(child).toBe(op);
      expect(currentTrustedOperation()).toBe(op);
      expect(child.deadline - performance.now()).toBe(600);
      child.assertCanCommit();
      return "committed";
    });
  });
  await expect(result).resolves.toBe("committed");
  await op.settled;
  expect(currentTrustedOperation()).toBeUndefined();
});

it("does not leak an inherited operation into unrelated asynchronous work", async () => {
  const first = held();
  const op = read();
  const running = op.run(() => first.promise);
  await Promise.resolve();
  await withTrustedOperation({ kind: "refresh", name: "Independent refresh", budgetMs: 2000 }, async other => {
    expect(other).not.toBe(op);
    expect(other.budgetMs).toBe(2000);
  });
  first.resolve(); await running; await op.settled;
});

it("snapshots settings at admission and gives a handed-over budget a fresh deadline", async () => {
  let configured = 60_000;
  vi.spyOn(limits, "dataProcessingTimeoutMs", "get").mockImplementation(() => configured);
  const earlier = admitTrustedOperation({ kind: "import", name: "Upload" });
  await earlier.run(async () => { await vi.advanceTimersByTimeAsync(1000); configured = 120_000; });
  const processing = admitTrustedOperation({ kind: "import", name: "Upload", budgetMs: earlier.budgetMs });
  const next = admitTrustedOperation({ kind: "import", name: "Next import" });
  expect(processing.budgetMs).toBe(60_000);
  expect(processing.deadline).toBe(earlier.deadline + 1000);
  expect(next.budgetMs).toBe(120_000);
  await processing.run(async () => {}); await next.run(async () => {});
});

it.each(["interactive-read", "export"] as const)("cancels %s at last departure and owns cleanup through settlement", async kind => {
  const caller = new AbortController();
  const op = admitTrustedOperation({ kind, name: "Work", signal: caller.signal, budgetMs: 60_000 });
  const source = held(), cleanup = held();
  const cancel = vi.fn(() => source.resolve());
  op.onStop(cancel); op.defer(() => cleanup.promise);
  const result = observed(op.run(() => source.promise));
  await vi.advanceTimersByTimeAsync(100);
  caller.abort();
  expect((await result).error).toBeInstanceOf(EvaluationCancelled);
  expect(cancel).toHaveBeenCalledOnce();
  expect(op.settlementDeadline).toBe(op.decidedAt! + 35_000);
  let settled = false; void op.settled.then(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(34_999);
  expect(settled).toBe(false);
  cleanup.resolve(); await op.settled;
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["import", "refresh", "template-install", "geometry-change", "sketch-change"] as const)("lets accepted %s commit after departure", async kind => {
  const caller = new AbortController();
  const op = admitTrustedOperation({ kind, name: "Change", signal: caller.signal, budgetMs: 60_000 });
  const gate = held();
  const commit = vi.fn();
  const result = op.run(async () => { await gate.promise; op.assertCanCommit(); commit(); });
  caller.abort();
  await vi.advanceTimersByTimeAsync(35_001);
  expect(op.signal.aborted).toBe(false);
  expect(op.decidedAt).toBeNull();
  expect(op.settlementDeadline).toBeNull();
  gate.resolve(); await result; await op.settled;
  expect(commit).toHaveBeenCalledOnce();
});

it("preserves shared work when one caller leaves and gives a joiner no new deadline", async () => {
  const one = new AbortController(), two = new AbortController();
  const op = read(one.signal);
  const source = held<string>();
  const result = op.run(() => source.promise);
  await vi.advanceTimersByTimeAsync(700);
  op.join(two.signal);
  const originalDeadline = op.deadline;
  one.abort();
  expect(op.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(299);
  expect(op.deadline).toBe(originalDeadline);
  source.resolve("shared result");
  await expect(result).resolves.toBe("shared result");
  await op.settled;
  two.abort(); expect(op.signal.aborted).toBe(false);
});

it("cancels a shared read only after its final interest leaves", async () => {
  const one = new AbortController(), two = new AbortController();
  const op = read(one.signal);
  const leave = op.join(two.signal);
  const source = held();
  op.onStop(() => source.resolve());
  const result = observed(op.run(() => source.promise));
  one.abort(); expect(op.signal.aborted).toBe(false);
  leave(); leave(); two.abort();
  expect((await result).error).toBeInstanceOf(EvaluationCancelled);
  await op.settled;
});

it("refuses expired shared work to a late joiner instead of reviving it", async () => {
  const op = read(); const source = held();
  const result = observed(op.run(() => source.promise));
  await vi.advanceTimersByTimeAsync(1000);
  const error = (await result).error;
  expect(() => op.join()).toThrow(error as Error);
  source.resolve(); await op.settled;
});

it.each(["interactive-read", "import"] as const)("handles an already departed %s caller by its policy", async kind => {
  const signal = AbortSignal.abort();
  const op = admitTrustedOperation({ kind, name: "Work", signal });
  const work = vi.fn(async () => 1);
  const result = await observed(op.run(work));
  if (kind === "import") { expect(result).toEqual({ value: 1 }); expect(work).toHaveBeenCalledOnce(); }
  else { expect(result.error).toBeInstanceOf(EvaluationCancelled); expect(work).not.toHaveBeenCalled(); }
  await op.settled;
});

it("rejects accepted work expiring immediately before commit even without a timer turn", async () => {
  const now = vi.spyOn(performance, "now").mockReturnValue(0);
  const caller = new AbortController();
  const op = admitTrustedOperation({ kind: "refresh", name: "Dataset refresh", budgetMs: 1000, signal: caller.signal });
  let artifact = "previous";
  const result = op.run(async () => {
    caller.abort();
    now.mockReturnValue(999); op.assertCanCommit();
    now.mockReturnValue(1000); op.assertCanCommit();
    artifact = "replacement";
  });
  await expect(result).rejects.toMatchObject({ code: "data_processing_timeout", status: 408 });
  await op.settled;
  expect(artifact).toBe("previous");
  expect(op.decidedAt).toBe(1000);
});

it("names the current stage, admitted seconds and setting in an expiry", async () => {
  const op = admitTrustedOperation({ kind: "import", name: "Roads import", budgetMs: 60_000 });
  const source = held();
  const result = observed(op.run(async () => { op.enterStage("artifact conversion"); await source.promise; }));
  await vi.advanceTimersByTimeAsync(60_000);
  expect((await result).error).toMatchObject({ code: "data_processing_timeout", message: expect.stringMatching(/Roads import.*60 s.*artifact conversion.*Data processing time limit/) });
  source.resolve(); await op.settled;
});

it("keeps the first typed refusal through later timeout, departure and source failure", async () => {
  const caller = new AbortController(); const op = read(caller.signal); const source = held();
  const error = new ApiError("remote_timeout", "The shorter source limit expired.", 504);
  const result = observed(op.run(() => source.promise));
  await Promise.resolve();
  op.refuse(error);
  await vi.advanceTimersByTimeAsync(2000); caller.abort();
  source.reject(new Error("Connection failed after interrupt"));
  expect((await result).error).toBe(error);
  await op.settled;
  expect(op.signal.reason).toBe(error);
});

it("keeps ownership until the native work and all cleanup settle, reporting an overdue owner", async () => {
  const op = read(); const native = held(); const cleanup = vi.fn(); op.defer(cleanup);
  const result = observed(op.run(() => native.promise));
  const settlement = observed(op.settled);
  await vi.advanceTimersByTimeAsync(1000);
  const refusal = (await result).error;
  await vi.advanceTimersByTimeAsync(34_999);
  expect(cleanup).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect((await settlement).error).toBeInstanceOf(TrustedSettlementOverdue);
  expect((await settlement).error).toMatchObject({ cause: refusal, allowanceMs: 35000 });
  native.resolve(); await op.drained;
  expect(cleanup).toHaveBeenCalledOnce();
  expect(() => op.assertCanCommit()).toThrow(refusal as Error);
  expect(vi.getTimerCount()).toBe(0);
});

it("starts settlement at resource refusal rather than at accepted departure", async () => {
  const caller = new AbortController();
  const op = admitTrustedOperation({ kind: "import", name: "Import", signal: caller.signal, budgetMs: 120_000 });
  const source = held(); const result = observed(op.run(() => source.promise));
  caller.abort(); await vi.advanceTimersByTimeAsync(40_000);
  expect(op.settlementDeadline).toBeNull();
  const refusal = trustedMemoryRefusal("Import", "scratch", 3072);
  op.refuse(refusal);
  expect(op.settlementDeadline).toBe(performance.now() + 35_000);
  expect((await result).error).toBe(refusal);
  source.resolve(); await op.settled;
});

it("observes cleanup and interrupt failures without skipping another resource", async () => {
  const op = read(); const source = held(); const cleanup = vi.fn();
  op.onStop(() => { throw new Error("Interrupt failed"); });
  op.defer(() => { throw new Error("Cleanup failed"); }); op.defer(cleanup);
  const result = observed(op.run(() => source.promise));
  const settlement = observed(op.settled);
  await vi.advanceTimersByTimeAsync(1000);
  expect((await result).error).toMatchObject({ code: "query_timeout" });
  source.resolve(); await op.drained;
  expect((await settlement).error).toBeInstanceOf(AggregateError);
  expect(cleanup).toHaveBeenCalledOnce();
});

it("releases successful ownership, listeners and clocks, and forbids reuse", async () => {
  const caller = new AbortController(); const remove = vi.spyOn(caller.signal, "removeEventListener");
  const op = read(caller.signal); const cleanup = vi.fn(); op.defer(cleanup);
  await expect(op.run(async () => 42)).resolves.toBe(42); await op.settled;
  expect(cleanup).toHaveBeenCalledOnce(); expect(remove).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  expect(() => op.assertCanCommit()).toThrow(/settled/);
  expect(() => op.run(async () => {})).toThrow(/once/);
});

it("keeps a resolved success while its cleanup crosses the deadline", async () => {
  const op = read(); const cleanup = held();
  op.defer(() => cleanup.promise);
  const result = observed(op.run(async () => "ready"));
  await vi.advanceTimersByTimeAsync(1000);
  const refusedDuringCleanup = op.signal.aborted;
  cleanup.resolve();
  const answer = await result; await op.settled;
  expect(refusedDuringCleanup).toBe(false);
  expect(answer).toEqual({ value: "ready" });
  expect(vi.getTimerCount()).toBe(0);
});

it.each([true, false])("keeps a committed success when a cleanup fails, reporting the failure through settlement and the log (marked=%s)", async marked => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const op = admitTrustedOperation({ kind: "import", name: "Link import", budgetMs: 100_000 });
  const later = vi.fn();
  op.defer(later); op.defer(() => { throw new Error("rm failed"); });
  const settlement = observed(op.settled);
  const answer = await observed(op.run(async () => { if (marked) op.markCommitted(); return "registered"; }));
  expect(answer).toEqual({ value: "registered" });
  expect((await settlement).error).toMatchObject({ message: "Link import cleanup failed." });
  expect(later).toHaveBeenCalledOnce();
  expect(warn).toHaveBeenCalledOnce();
  expect(warn).toHaveBeenCalledWith("Trusted import cleanup failed after its commit",
    expect.objectContaining({ message: "Link import cleanup failed.", errors: [expect.objectContaining({ message: "rm failed" })] }));
  await op.drained;
});

it("logs a committed mutation's cleanup failure once and answers with its value", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const answer = await observed(withTrustedMutation({ kind: "sketch-change", name: "Sketch change" }, async operation => {
    operation.defer(() => { throw new Error("tile removal failed"); });
    operation.markCommitted();
    return "saved";
  }));
  expect(answer).toEqual({ value: "saved" });
  expect(warn).toHaveBeenCalledOnce();
  expect(warn).toHaveBeenCalledWith("Trusted sketch-change cleanup failed after its commit", expect.objectContaining({ message: "Sketch change cleanup failed." }));
});

it("leaves a refused operation's cleanup failure to its refusal and writes no commit line", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const op = read(); const source = held();
  op.defer(() => { throw new Error("Cleanup failed"); });
  const result = observed(op.run(() => source.promise));
  await vi.advanceTimersByTimeAsync(1000);
  expect((await result).error).toMatchObject({ code: "query_timeout" });
  source.resolve(); await op.drained;
  expect(warn).not.toHaveBeenCalled();
});

it("control: a committed success whose cleanup does not fail resolves and settles", async () => {
  const op = admitTrustedOperation({ kind: "import", name: "Link import", budgetMs: 100_000 });
  op.defer(() => {});
  expect(await observed(op.run(async () => { op.markCommitted(); return "registered"; }))).toEqual({ value: "registered" });
  await expect(op.settled).resolves.toBeUndefined();
});

it("keeps a committed success through later work, the deadline and departure", async () => {
  const caller = new AbortController();
  const op = admitTrustedOperation({ kind: "export", name: "Dataset export", signal: caller.signal, budgetMs: 1000 });
  const result = observed(op.run(async () => {
    op.assertCanCommit(); op.markCommitted();
    await vi.advanceTimersByTimeAsync(2000); caller.abort();
    op.assertCanCommit();
    return "written";
  }));
  expect(await result).toEqual({ value: "written" });
  await op.settled;
  expect(op.decidedAt).toBeNull(); expect(op.signal.aborted).toBe(false);
});

it("reports cleanup overdue after a commit separately from the success", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const op = read(); const cleanup = held();
  op.defer(() => cleanup.promise);
  const result = observed(op.run(async () => "ready"));
  const settlement = observed(op.settled);
  await vi.advanceTimersByTimeAsync(35_000);
  expect((await settlement).error).toBeInstanceOf(TrustedSettlementOverdue);
  expect((await settlement).error).toMatchObject({ message: expect.stringContaining("of its commit") });
  cleanup.resolve();
  expect(await result).toEqual({ value: "ready" });
  await op.drained; expect(vi.getTimerCount()).toBe(0);
});

it.each([true, false])("answers a committed value at the settlement allowance while its cleanup is held, and keeps owning that cleanup (mutation=%s)", async mutation => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const cleanup = held(); let cleaned = false;
  let op: TrustedOperation | undefined;
  const work = async (operation: TrustedOperation) => {
    op = operation;
    operation.defer(async () => { await cleanup.promise; cleaned = true; });
    operation.markCommitted(); return "registered";
  };
  const options = { kind: "import" as const, name: "Link import", budgetMs: 100_000 };
  let answer: { value?: string; error?: unknown } | undefined;
  void observed(mutation ? withTrustedMutation(options, work) : admitTrustedOperation(options).run(work)).then(result => { answer = result; });
  await vi.advanceTimersByTimeAsync(0);
  let drained = false; void op!.drained.then(() => { drained = true; });
  const settlement = observed(op!.settled);
  await vi.advanceTimersByTimeAsync(34_999);
  expect(answer).toBeUndefined();
  expect(warn).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  // Answered at the allowance, before the held cleanup is released.
  expect(answer).toEqual({ value: "registered" });
  expect(cleaned).toBe(false); expect(drained).toBe(false);
  expect(warn).toHaveBeenCalledOnce();
  expect(warn).toHaveBeenCalledWith("Trusted import cleanup overdue after its commit", expect.any(TrustedSettlementOverdue));
  expect((await settlement).error).toBeInstanceOf(TrustedSettlementOverdue);
  // The operation still owns the cleanup: it drains only when the cleanup does.
  await vi.advanceTimersByTimeAsync(60_000);
  expect(drained).toBe(false);
  cleanup.resolve(); await op!.drained;
  expect(cleaned).toBe(true);
  expect(warn).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("control: a committed value whose cleanup finishes inside the allowance waits for it and logs nothing", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const op = admitTrustedOperation({ kind: "import", name: "Link import", budgetMs: 100_000 });
  const cleanup = held(); let cleaned = false;
  op.defer(async () => { await cleanup.promise; cleaned = true; });
  let answer: { value?: string } | undefined;
  void observed(op.run(async () => { op.markCommitted(); return "registered"; })).then(result => { answer = result; });
  await vi.advanceTimersByTimeAsync(34_000);
  expect(answer).toBeUndefined();
  cleanup.resolve(); await op.drained;
  await vi.advanceTimersByTimeAsync(0);
  expect(answer).toEqual({ value: "registered" }); expect(cleaned).toBe(true);
  expect(warn).not.toHaveBeenCalled();
});

it("does not commit refused work, and an error after a commit is still the work's own", async () => {
  const refused = read(); const source = held();
  const answer = observed(refused.run(() => source.promise));
  await vi.advanceTimersByTimeAsync(1000);
  refused.markCommitted();
  expect((await answer).error).toMatchObject({ code: "query_timeout" });
  source.resolve(); await refused.settled;
  const failing = read(); const broken = new Error("Post-commit bookkeeping failed.");
  await expect(failing.run(async () => { failing.markCommitted(); throw broken; })).rejects.toBe(broken);
  await failing.settled;
});

it("runs a newly acquired resource's stop hook even after refusal", async () => {
  const op = read(); const source = held(); const result = observed(op.run(() => source.promise));
  await vi.advanceTimersByTimeAsync(1000);
  const interrupt = vi.fn(); op.onStop(interrupt);
  expect(interrupt).toHaveBeenCalledOnce();
  source.resolve(); await result; await op.settled;
});

describe("typed refusals", () => {
  it.each(["memory", "scratch"] as const)("names work and the shared %s budget and deployment remedy", resource => {
    const error = trustedMemoryRefusal("Roads import", resource, 3072);
    expect(error).toMatchObject({ code: "engine_memory_exceeded", status: 422 });
    expect(error.message).toContain("Roads import");
    expect(error.message).toContain(resource === "memory" ? "3072 MB" : "12288 MB");
    expect(error.message).toContain("shared"); expect(error.message).toContain(resource);
    expect(error.message).toContain("DEZFIL_TRUSTED_MEMORY_MB");
  });
  it("recognizes coded outcomes by type, without allowing error text to forge one", () => {
    for (const error of [new EvaluationCancelled(), new ApiError("query_memory_exceeded", "Hardened refusal", 400),
      new ApiError("operation_timeout", "Shorter limit", 408), new ApiError("render_timeout", "Image limit", 408),
      new ApiError("remote_timeout", "Source limit", 504), trustedMemoryRefusal("Import", "memory", 3072)]) {
      expect(isTrustedOperationRefusal(error)).toBe(true);
    }
    expect(isTrustedOperationRefusal(new Error("engine_memory_exceeded query_timeout"))).toBe(false);
    expect(isTrustedOperationRefusal({ code: "query_timeout", status: 408 })).toBe(false);
  });
  it.each([
    ["engine_memory_exceeded", 422], ["data_processing_timeout", 408],
    ["upload_stalled", 408], ["render_bytes_exceeded", 422],
  ] as const)("publishes and preserves %s with status %s", async (code, status) => {
    expect(RESOURCE_ERROR_STATUSES[code]).toBe(status);
    expect(ERROR_CATALOGUE[code]).toEqual(expect.any(String));
    const error = new ApiError(code, ERROR_CATALOGUE[code], status);
    const response = errorResponse(error);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code, message: ERROR_CATALOGUE[code] } });
  });
});


it("preserves a nested typed refusal even if a wrapper catches it and attempts a commit", async () => {
  const failure = new ApiError("query_memory_exceeded", "Hardened validation refused.", 400);
  const op = admitTrustedOperation({ kind: "template-install", name: "Template install", budgetMs: 1000 });
  const commit = vi.fn();
  const result = op.run(async () => {
    try {
      await withTrustedOperation({ kind: "interactive-read", name: "Validate" }, async () => { throw failure; });
    } catch { /* The outer guard still owns the refusal. */ }
    op.assertCanCommit(); commit();
  });
  await expect(result).rejects.toBe(failure); await op.settled;
  expect(commit).not.toHaveBeenCalled();
});

it("leaves an ordinary nested error to the wrapper that translates it", async () => {
  const translated = new ApiError("not_refreshable", "The stored recipe no longer resolves.", 409);
  const op = admitTrustedOperation({ kind: "refresh", name: "Dataset refresh", budgetMs: 1000 });
  const result = op.run(async () => {
    try {
      await withTrustedOperation({ kind: "interactive-read", name: "Source read" }, async () => {
        throw new ApiError("not_found", "Table public.roads has no columns or does not exist.", 404);
      });
    } catch { throw translated; }
  });
  await expect(result).rejects.toBe(translated); await op.settled;
  expect(op.signal.reason).toBe(translated);
});

it("decides at once in a helper's catch only for a lifetime outcome", async () => {
  const op = read(); const source = held(); const result = observed(op.run(() => source.promise));
  op.refuseIfFinal(new ApiError("malformed_file", "Unreadable.", 422));
  expect(op.decidedAt).toBeNull(); expect(op.signal.aborted).toBe(false);
  const memory = trustedMemoryRefusal("Dataset inspection", "memory", 3072);
  op.refuseIfFinal(memory);
  expect((await result).error).toBe(memory);
  source.resolve(); await op.settled;
});

it.each([
  ["a departure", new EvaluationCancelled(), true], ["the query limit", new ApiError("query_timeout", "Limit", 408), true],
  ["the processing limit", new ApiError("data_processing_timeout", "Limit", 408), true],
  ["a source time limit", new ApiError("remote_timeout", "Source limit", 504), true],
  ["engine memory", new ApiError("engine_memory_exceeded", "Memory", 422), true],
  ["hardened memory", new ApiError("query_memory_exceeded", "Hardened", 400), true],
  ["a missing table", new ApiError("not_found", "Missing", 404), false],
  ["unreadable data", new ApiError("malformed_file", "Unreadable", 422), false],
  ["a refused fetch", new ApiError("remote_fetch_failed", "Refused", 502), false],
  ["a size cap", new ApiError("upload_too_large", "Too large", 413), false],
  ["uncoded text naming a code", new Error("query_timeout"), false],
] as const)("classes %s as a lifetime outcome: %s", (_label, error, expected) => {
  expect(isLifetimeOutcome(error)).toBe(expected);
});

it("does not let a detached stop hook interrupt a released resource", async () => {
  const op = read(); const source = held(); const stop = vi.fn();
  const release = op.onStop(stop); release();
  const result = observed(op.run(() => source.promise));
  await vi.advanceTimersByTimeAsync(1000);
  expect(stop).not.toHaveBeenCalled();
  source.resolve(); await result; await op.settled;
});

it("uses monotonic elapsed time despite a wall clock correction", async () => {
  const op = read(); const start = op.deadline; const source = held();
  const result = op.run(() => source.promise);
  vi.setSystemTime(Date.now() + 1_000_000);
  await vi.advanceTimersByTimeAsync(999);
  op.assertCanCommit(); expect(op.deadline).toBe(start);
  source.resolve(); await result; await op.settled;
});

it("does not truncate a large deployment deadline to a one millisecond timer", async () => {
  const op = read(undefined, 2_147_483_648); const source = held();
  const result = observed(op.run(() => source.promise));
  await vi.advanceTimersByTimeAsync(2_147_483_647);
  expect(op.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect((await result).error).toMatchObject({ code: "query_timeout" });
  source.resolve(); await op.settled;
});

it("publishes resource codes and HTTP statuses in the served contract", () => {
  const doc = buildOpenApiDocument();
  expect(doc["x-resource-error-statuses"]).toEqual({ engine_memory_exceeded: 422,
    data_processing_timeout: 408, upload_stalled: 408, request_timeout: 408, render_bytes_exceeded: 422 });
  for (const code of Object.keys(RESOURCE_ERROR_STATUSES)) expect(doc["x-error-codes"]).toHaveProperty(code);
});
