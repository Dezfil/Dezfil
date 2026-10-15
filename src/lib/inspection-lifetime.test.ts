import { purgeQueryStores } from "@/lib/query/retained";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { DuckDBInstance as NativeInstance } from "@duckdb/node-api";
import { listProjections } from "./geometry/projections";
import { inspectionCache } from "./geometry/inspection-cache";
import type { DataTable } from "./metadata/tables";
import { currentTrustedOperation, withTrustedOperation } from "./trusted-operation";
import { EvaluationCancelled } from "./api/errors";

vi.mock("./limits", () => ({ limits: { queryTimeoutMs: 100, dataProcessingTimeoutMs: 1000, trustedMemoryMb: 3072 } }));
vi.mock("./settings/remedy", () => ({ settingRemedy: () => "Change the time limit." }));

const conn = { run: vi.fn(), runAndReadAll: vi.fn(), interrupt: vi.fn(), disconnectSync: vi.fn() };
const connect = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  conn.run.mockResolvedValue(undefined); conn.runAndReadAll.mockResolvedValue({});
  connect.mockResolvedValue(conn);
  vi.spyOn(NativeInstance, "create").mockImplementation(async () => ({
    connect: vi.fn().mockResolvedValueOnce({ run: vi.fn().mockResolvedValue(undefined), disconnectSync: vi.fn() }).mockImplementation(connect),
    closeSync: vi.fn(),
  }) as unknown as DuckDBInstance);
});
afterEach(async () => { await purgeQueryStores(); vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });
const flush = () => vi.advanceTimersByTimeAsync(0);

it("expires projection preparation before a late connection can run statements", async () => {
  const held = Promise.withResolvers<DuckDBConnection>(); connect.mockReturnValueOnce(held.promise);
  const work = (listProjections as (q: string) => Promise<unknown>)("4326").catch(e => e);
  await vi.advanceTimersByTimeAsync(101);
  held.resolve(conn as unknown as DuckDBConnection);
  await flush();
  expect(await work).toMatchObject({ code: "query_timeout", status: 408 });
  expect(conn.run).not.toHaveBeenCalled(); expect(conn.disconnectSync).toHaveBeenCalledOnce();
});

it("interrupts a departed projection reader and retains cancellation identity", async () => {
  const caller = new AbortController();
  const held = Promise.withResolvers<never>();
  conn.runAndReadAll.mockReturnValueOnce(held.promise);
  conn.interrupt.mockImplementationOnce(() => held.reject(new Error("INTERRUPT Error")));
  const work = (listProjections as (q: string, s: AbortSignal) => Promise<unknown>)("4326", caller.signal).catch(e => e);
  await flush(); caller.abort(); await flush();
  // Release the old unbounded implementation as well, so the red run settles.
  held.reject(new Error("INTERRUPT Error"));
  expect(await work).toBeInstanceOf(EvaluationCancelled);
  expect(conn.interrupt).toHaveBeenCalledOnce(); expect(conn.disconnectSync).toHaveBeenCalledOnce();
});

it.each(["Out of Memory Error: could not allocate block", "Out of Memory Error: failed to offload data block: max_temp_directory_size limit"])("keeps a trusted memory refusal through projection validation: %s", async message => {
  conn.runAndReadAll.mockRejectedValueOnce(new Error(message));
  await expect(listProjections("4326")).rejects.toMatchObject({ code: "engine_memory_exceeded", status: 422 });
});

it("a shared geometry inspection survives one departure and keeps its first deadline", async () => {
  const cache = inspectionCache<string>();
  const table = { id: "shared", file: "one" } as DataTable;
  const a = new AbortController(), b = new AbortController();
  const held = Promise.withResolvers<string>();
  let owner: ReturnType<typeof currentTrustedOperation>;
  const read = vi.fn(() => { owner = currentTrustedOperation(); return held.promise; });
  const first = withTrustedOperation({ kind: "interactive-read", name: "First", signal: a.signal }, () => cache(table, read)).catch(e => e);
  await flush(); await vi.advanceTimersByTimeAsync(40);
  const second = withTrustedOperation({ kind: "interactive-read", name: "Second", signal: b.signal }, () => cache(table, read)).catch(e => e);
  await flush(); a.abort(); await flush();
  expect(await first).toBeInstanceOf(EvaluationCancelled);
  expect(owner?.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(61); held.resolve("late"); await flush();
  expect(await second).toMatchObject({ code: "query_timeout" }); expect(read).toHaveBeenCalledOnce();
});

it("shared geometry work interrupts after its last interested reader leaves", async () => {
  const cache = inspectionCache<string>(), caller = new AbortController();
  const held = Promise.withResolvers<string>(); let owner: ReturnType<typeof currentTrustedOperation>;
  const work = withTrustedOperation({ kind: "interactive-read", name: "Inspection", signal: caller.signal }, () => cache({ id: "last", file: "one" } as DataTable, () => {
    owner = currentTrustedOperation(); return held.promise;
  })).catch(e => e);
  await flush(); caller.abort(); await flush();
  expect(await work).toBeInstanceOf(EvaluationCancelled); expect(owner?.signal.aborted).toBe(true);
  held.resolve("late"); await flush();
});
