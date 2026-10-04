import { afterEach, beforeEach, expect, it, vi } from "vitest";
import path from "node:path";

const files = vi.hoisted(() => ({ mkdirSync: vi.fn(), watchFile: vi.fn(), readFileSync: vi.fn(), writeFileSync: vi.fn() }));
vi.mock("node:fs", () => ({ default: files }));
type Work = { database: string; accounts: Set<string>; settled: Promise<void>; released: boolean };
const key = Symbol.for("dezfil.account-deletion-admission");
const host = process as typeof process & { [key]?: { work: Set<Work> } };
let changed: () => Promise<void>;

beforeEach(async () => {
  vi.useFakeTimers(); vi.clearAllMocks(); vi.resetModules();
  vi.stubEnv("DEZFIL_PROOF_CONTROL_DIR", path.join(process.env.DEZFIL_DATA_DIR!, "control"));
  delete host[key];
  await import("../../../scripts/account-deletion-journey-preload.mjs");
  changed = files.watchFile.mock.calls[0][2];
});
afterEach(() => { delete host[key]; vi.useRealTimers(); vi.unstubAllEnvs(); });
function request(id: string, command: string) {
  files.readFileSync.mockReturnValue(JSON.stringify({ id, command, accountId: "target" }));
  return changed();
}
function reply() {
  return JSON.parse(files.writeFileSync.mock.lastCall![1]);
}

it("waits for the application to create its holder, then holds and releases work on that exact holder", async () => {
  const pending = request("hold", "hold");
  await vi.advanceTimersByTimeAsync(75);
  expect(host[key], "the preload must not create the product holder").toBeUndefined();
  expect(files.writeFileSync).not.toHaveBeenCalled();
  const holder = { work: new Set<Work>() }; host[key] = holder;
  await vi.advanceTimersByTimeAsync(25); await pending;
  expect(host[key]).toBe(holder);
  expect(reply()).toEqual({ id: "hold", ok: true });
  expect(holder.work.size).toBe(1);
  const [work] = holder.work;
  expect(work.database).toBe(path.join(process.env.DEZFIL_DATA_DIR!, "metadata.sqlite"));
  expect([...work.accounts]).toEqual(["target"]);
  expect(work.released).toBe(false);
  await request("release", "release");
  expect(reply()).toEqual({ id: "release", ok: true });
  await expect(work.settled).resolves.toBeUndefined();
  expect(work.released).toBe(true); expect(work.accounts.size).toBe(0); expect(holder.work.size).toBe(0);
});
it("reports a bounded holder timeout to the requesting journey without creating a holder", async () => {
  const pending = request("missing", "hold");
  await vi.advanceTimersByTimeAsync(4975);
  expect(files.writeFileSync).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(25); await pending;
  expect(reply()).toEqual({ id: "missing", error: "Built application has no process-wide admission holder deadline (5000 ms)" });
  expect(host[key]).toBeUndefined();
});
it("processes a repeated file notification only once while awaiting the holder", async () => {
  const pending = request("same", "hold");
  await request("same", "hold");
  const holder = { work: new Set<Work>() }; host[key] = holder;
  await vi.advanceTimersByTimeAsync(25); await pending;
  expect(holder.work.size).toBe(1); expect(files.writeFileSync).toHaveBeenCalledTimes(1);
  expect(reply()).toEqual({ id: "same", ok: true });
});
it("rejects the removed replay command instead of acknowledging an ineffective seed", async () => {
  host[key] = { work: new Set<Work>() };
  await request("replay", "replay");
  expect(reply()).toEqual({ id: "replay", error: "Unknown proof control" });
});
