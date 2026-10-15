import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DataTable } from "./metadata/tables";
import { inspectionCache } from "./geometry/inspection-cache";
import { admitTrustedOperation, currentTrustedOperation } from "./trusted-operation";
import { sharedTrustedWork } from "./trusted-shared";

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

it("commits every caller waiting on shared work when that work commits", async () => {
  const parent = admitTrustedOperation({ kind: "template-install", name: "Template installation", budgetMs: 100 });
  const cleanup = Promise.withResolvers<void>();
  const result = parent.run(async () => {
    const shared = sharedTrustedWork({ kind: "template-install", name: "Template download" }, async () => {
      currentTrustedOperation()!.markCommitted();
      // The scratch removal after the version is in place.
      await cleanup.promise;
      return "installed";
    });
    return shared.join();
  });
  await vi.advanceTimersByTimeAsync(150);
  const refusedDuringCleanup = parent.signal.aborted;
  cleanup.resolve();
  await expect(result).resolves.toBe("installed");
  expect(refusedDuringCleanup).toBe(false);
  await parent.settled;
});
