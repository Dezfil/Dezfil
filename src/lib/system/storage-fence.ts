import { admitStorageWrite } from "./storage-admission";
import type { ApiError } from "@/lib/api/errors";
import { AsyncLocalStorage } from "node:async_hooks";
import { storageExhausted } from "./storage-errors";

/** Matches the trusted owner's settlement allowance, without importing it
 * into its own registry. Recovery never waits indefinitely for a writer. */
export const STORAGE_SETTLEMENT_MS = 35_000;
const key = Symbol.for("dezfil.storage-writers");
const host = globalThis as typeof globalThis & { [key]?: { fenced: boolean; writers: Set<StorageWriter> } };
const state = host[key] ??= { fenced: false, writers: new Set<StorageWriter>() };
const context = new AsyncLocalStorage<StorageWriter>();
export const currentStorageWriter = () => context.getStore();
export function assertStorageWritersOpen(): void { if (state.fenced) throw storageExhausted(); }

export class StorageWriter {
  private readonly controller = new AbortController();
  private readonly completion = Promise.withResolvers<void>();
  readonly settled = this.completion.promise;
  readonly signal = this.controller.signal;

  constructor(private readonly stop?: (error: ApiError) => void, declaredBytes = 0) {
    assertStorageWritersOpen();
    admitStorageWrite(declaredBytes);
    state.writers.add(this);
  }
  assertCanCommit(): void {
    if (this.signal.aborted) throw this.signal.reason;
  }
  refuse(error: ApiError): void {
    if (this.signal.aborted) return;
    this.controller.abort(error);
    this.stop?.(error);
  }
  /** Release only after native work, streams and partial cleanup settle. */
  close(): void { state.writers.delete(this); this.completion.resolve(); }
}

export async function withStorageWrite<T>(work: (writer: StorageWriter) => Promise<T>, declaredBytes = 0): Promise<T> {
  const inherited = currentStorageWriter();
  if (inherited) { inherited.assertCanCommit(); return work(inherited); }
  const writer = new StorageWriter(undefined, declaredBytes);
  try {
    const value = await context.run(writer, () => work(writer));
    writer.assertCanCommit();
    return value;
  } catch (error) { writer.assertCanCommit(); throw error; }
  finally { writer.close(); }
}

export function storageWritersState(): { fenced: boolean; live: number } {
  return { fenced: state.fenced, live: state.writers.size };
}

/** The recovery latch owns the returned release until its write completes.
 * New writers are refused throughout both settlement and reserve release. */
export async function fenceStorageWriters(allowanceMs = STORAGE_SETTLEMENT_MS): Promise<{ release(): void; elapsedMs: number; overdue: number }> {
  if (state.fenced) throw new Error("Storage recovery must hold its latch before fencing.");
  const reason = storageExhausted();
  state.fenced = true;
  const started = performance.now();
  const writers = [...state.writers];
  for (const writer of writers) {
    try { writer.refuse(reason); }
    catch (error) { console.warn("[storage] writer stop failed:", error); }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(writers.map(writer => writer.settled)),
      new Promise<void>(resolve => { timer = setTimeout(resolve, allowanceMs); }),
    ]);
  } finally { clearTimeout(timer); }
  const overdue = writers.filter(writer => state.writers.has(writer)).length;
  const elapsedMs = performance.now() - started;
  if (overdue) console.warn(`[storage] ${overdue} writers did not settle within ${allowanceMs} ms`);
  console.info(`[storage] fence settled in ${Math.round(elapsedMs)} ms; ${overdue} overdue`);
  return { release() { state.fenced = false; }, elapsedMs, overdue };
}
