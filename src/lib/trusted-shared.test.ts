import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DataTable } from "./metadata/tables";
import { inspectionCache } from "./geometry/inspection-cache";
import { admitTrustedOperation, currentTrustedOperation } from "./trusted-operation";
import { sharedTrustedWork } from "./trusted-shared";
import { EvaluationCancelled } from "./api/errors";

vi.mock("./settings/remedy", () => ({ settingRemedy: () => "Change the time limit." }));
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] }));
afterEach(() => vi.useRealTimers());

it("a departed reader drains independently and cannot evict work another reader still needs", async () => {
  const cache = inspectionCache<string>(), table = { id: "shared", file: "one" } as DataTable;
  const a = new AbortController();
  const first = admitTrustedOperation({ kind: "interactive-read", name: "First", budgetMs: 100_000, signal: a.signal });
  const second = admitTrustedOperation({ kind: "interactive-read", name: "Second", budgetMs: 100_000 });
  const third = admitTrustedOperation({ kind: "interactive-read", name: "Third", budgetMs: 100_000 });
  const held = Promise.withResolvers<string>(), read = vi.fn(() => held.promise);
  const one = first.run(() => cache(table, read)).catch(error => error);
  const two = second.run(() => cache(table, read));
  await vi.advanceTimersByTimeAsync(0); a.abort(); await one;
  let drained = false; void first.drained.then(() => { drained = true; });
  await vi.advanceTimersByTimeAsync(0); const independentlyDrained = drained;
  const three = third.run(() => cache(table, read));
  await vi.advanceTimersByTimeAsync(0); const readsBeforeCompletion = read.mock.calls.length;
  held.resolve("answer"); await Promise.all([two, three, first.drained]);
  expect(independentlyDrained).toBe(true); expect(readsBeforeCompletion).toBe(1);
});

it("a shared processing stage retains its parent's absolute deadline, refusal and admitted limit", async () => {
  const parent = admitTrustedOperation({ kind: "import", name: "Import", budgetMs: 100 });
  let sharedOwner: ReturnType<typeof currentTrustedOperation>;
  const held = Promise.withResolvers<void>();
  const sharedReady = Promise.withResolvers<ReturnType<typeof sharedTrustedWork<void>>>();
  const work = parent.run(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 40));
    const shared = sharedTrustedWork({ kind: "interactive-read", name: "Source preparation" }, async () => {
      sharedOwner = currentTrustedOperation(); await held.promise;
    });
    sharedReady.resolve(shared);
    return shared.join();
  }).catch(error => error);
  await vi.advanceTimersByTimeAsync(40);
  const shared = await sharedReady.promise;
  const joiner = admitTrustedOperation({ kind: "interactive-read", name: "Joiner", budgetMs: 1000 });
  const joined = joiner.run(() => shared.join()).catch(error => error);
  await vi.advanceTimersByTimeAsync(0);
  const inherited = { kind: sharedOwner?.kind, budgetMs: sharedOwner?.budgetMs, deadline: sharedOwner?.deadline };
  await vi.advanceTimersByTimeAsync(61); held.resolve(); await work; await parent.drained;
  expect(inherited).toEqual({ kind: "import", budgetMs: 100, deadline: parent.deadline });
  expect(await joined).toMatchObject({ code: "data_processing_timeout", message: expect.stringContaining("0.1 s processing") });
});

it("shared processing work stops when its last parent refuses, even before the deadline", async () => {
  const parent = admitTrustedOperation({ kind: "import", name: "Import", budgetMs: 100_000 });
  const held = Promise.withResolvers<void>(); let sharedOwner: ReturnType<typeof currentTrustedOperation>;
  const work = parent.run(() => sharedTrustedWork({ kind: "interactive-read", name: "Source preparation" }, async () => {
    sharedOwner = currentTrustedOperation(); await held.promise;
  }).join()).catch(error => error);
  await vi.advanceTimersByTimeAsync(0); parent.refuse(new Error("Source no longer needed")); await work;
  expect(sharedOwner?.signal.aborted).toBe(true); held.resolve(); await parent.drained;
});

it.each([true, false])("commits the callers waiting on shared work when it commits only when the work says so (commitsJoiners=%s)", async commitsJoiners => {
  const parent = admitTrustedOperation({ kind: "template-install", name: "Template installation", budgetMs: 100 });
  const cleanup = Promise.withResolvers<void>();
  const result = parent.run(async () => {
    const shared = sharedTrustedWork({ kind: "template-install", name: "Template download" }, async () => {
      currentTrustedOperation()!.markCommitted();
      // The scratch removal after the version is in place.
      await cleanup.promise;
      return "installed";
    }, { commitsJoiners });
    return shared.join();
  }).then(value => ({ value }), error => ({ error }));
  await vi.advanceTimersByTimeAsync(150);
  const refusedDuringCleanup = parent.signal.aborted;
  cleanup.resolve();
  if (commitsJoiners) expect(await result).toEqual({ value: "installed" });
  else expect(await result).toEqual({ error: expect.objectContaining({ code: "data_processing_timeout" }) });
  expect(refusedDuringCleanup).toBe(!commitsJoiners);
  await parent.settled;
});

/** A first caller completes a shared read, as a cache keeps it for later callers. */
async function finishedSharedRead() {
  const first = admitTrustedOperation({ kind: "interactive-read", name: "First", budgetMs: 100_000 });
  let shared!: ReturnType<typeof sharedTrustedWork<string>>;
  await first.run(async () => {
    shared = sharedTrustedWork({ kind: "interactive-read", name: "Overture divisions" }, async () => "cached");
    return shared.join();
  });
  await first.settled;
  return shared;
}

it("a later caller joining a finished shared read is still refused at its own deadline", async () => {
  const shared = await finishedSharedRead();
  const second = admitTrustedOperation({ kind: "interactive-read", name: "Second", budgetMs: 1000 });
  const slow = Promise.withResolvers<string>();
  const result = second.run(async () => { await shared.join(); return slow.promise; }).then(value => ({ value }), error => ({ error }));
  await vi.advanceTimersByTimeAsync(1000);
  const refusedAtDeadline = second.signal.aborted;
  slow.resolve("late");
  expect(refusedAtDeadline).toBe(true);
  expect(await result).toEqual({ error: expect.objectContaining({ code: "query_timeout" }) });
  await second.settled;
});

it("a later caller joining a finished shared read is still cancelled when its caller leaves", async () => {
  const shared = await finishedSharedRead();
  const caller = new AbortController();
  const second = admitTrustedOperation({ kind: "interactive-read", name: "Second", budgetMs: 100_000, signal: caller.signal });
  const slow = Promise.withResolvers<string>();
  const result = second.run(async () => { await shared.join(); return slow.promise; }).then(value => ({ value }), error => ({ error }));
  await vi.advanceTimersByTimeAsync(0); caller.abort();
  const cancelled = second.signal.aborted;
  slow.resolve("late");
  expect(cancelled).toBe(true);
  expect(await result).toEqual({ error: expect.any(EvaluationCancelled) });
  await second.settled;
});

it("an import joining a finished shared read cannot commit after its deadline", async () => {
  const shared = await finishedSharedRead();
  const op = admitTrustedOperation({ kind: "import", name: "Overture import", budgetMs: 100 });
  let committed = false;
  const result = op.run(async () => {
    await shared.join();
    await vi.advanceTimersByTimeAsync(5000);
    op.assertCanCommit(); committed = true; return "registered";
  }).then(value => ({ value }), error => ({ error }));
  expect(await result).toEqual({ error: expect.objectContaining({ code: "data_processing_timeout" }) });
  expect(committed).toBe(false);
  await op.settled;
});

it("a second reader of a cached geometry inspection keeps its departure policy", async () => {
  const cache = inspectionCache<string>(), table = { id: "cached", file: "one" } as DataTable;
  const first = admitTrustedOperation({ kind: "interactive-read", name: "First", budgetMs: 100_000 });
  await first.run(() => cache(table, async () => "inspected")); await first.settled;
  const caller = new AbortController();
  const second = admitTrustedOperation({ kind: "interactive-read", name: "Second", budgetMs: 100_000, signal: caller.signal });
  const slow = Promise.withResolvers<string>();
  const result = second.run(async () => { await cache(table, async () => "never"); return slow.promise; }).then(value => ({ value }), error => ({ error }));
  await vi.advanceTimersByTimeAsync(0); caller.abort();
  const cancelled = second.signal.aborted;
  slow.resolve("late");
  expect(cancelled).toBe(true);
  expect(await result).toEqual({ error: expect.any(EvaluationCancelled) });
  await second.settled;
});

it("control: joining a shared read that is still running does not commit the joiner", async () => {
  const held = Promise.withResolvers<string>();
  const first = admitTrustedOperation({ kind: "interactive-read", name: "First", budgetMs: 100_000 });
  let shared!: ReturnType<typeof sharedTrustedWork<string>>;
  const firstRun = first.run(async () => { shared = sharedTrustedWork({ kind: "interactive-read", name: "Overture divisions" }, () => held.promise); return shared.join(); });
  await vi.advanceTimersByTimeAsync(0);
  const second = admitTrustedOperation({ kind: "interactive-read", name: "Second", budgetMs: 1000 });
  const slow = Promise.withResolvers<string>();
  const result = second.run(async () => { await shared.join(); return slow.promise; }).then(value => ({ value }), error => ({ error }));
  await vi.advanceTimersByTimeAsync(10); held.resolve("cached"); await firstRun; await first.settled;
  await vi.advanceTimersByTimeAsync(1000);
  const refusedAtDeadline = second.signal.aborted;
  slow.resolve("late");
  expect(refusedAtDeadline).toBe(true);
  expect(await result).toEqual({ error: expect.objectContaining({ code: "query_timeout" }) });
  await second.settled;
});

it("control: the same caller without a shared join is refused at its deadline", async () => {
  const second = admitTrustedOperation({ kind: "interactive-read", name: "Second", budgetMs: 1000 });
  const slow = Promise.withResolvers<string>();
  const result = second.run(() => slow.promise).then(value => ({ value }), error => ({ error }));
  await vi.advanceTimersByTimeAsync(1000);
  const refusedAtDeadline = second.signal.aborted;
  slow.resolve("late");
  expect(refusedAtDeadline).toBe(true);
  expect(await result).toEqual({ error: expect.objectContaining({ code: "query_timeout" }) });
  await second.settled;
});
