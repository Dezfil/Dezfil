import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDerivationAdmission, withPasswordDerivation } from "./derivation-admission";
import { authFailure } from "./http";
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
function held() {
  const admission = createDerivationAdmission(), starts: string[] = [];
  const finishes = new Map<string, { resolve: (value: string) => void; reject: (error: Error) => void }>();
  const run = (id: string, kind: "ordinary" | "protected" = "ordinary", signal?: AbortSignal) => {
    const promise = admission.run(() => { starts.push(id); return new Promise<string>((resolve, reject) => finishes.set(id, { resolve, reject })); }, { class: kind, signal });
    promise.catch(() => {}); return promise;
  };
  const end = async (id: string) => { finishes.get(id)!.resolve(id); await flush(); };
  return { ...admission, run, starts, finishes, end };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("holds two active, six ordinary and two reserved protected waiters, with immediate class overflow", async () => {
  const q = held(), pending = [q.run("o0"), q.run("o1")];
  for (let i = 2; i < 8; i++) pending.push(q.run(`o${i}`));
  pending.push(q.run("p0", "protected"), q.run("p1", "protected"));
  expect(q.starts).toEqual(["o0", "o1"]);
  expect(q.snapshot()).toEqual({ active: 2, activeProtected: 0, ordinary: 6, protected: 2 });
  for (const kind of ["ordinary", "protected"] as const) await expect(q.run("overflow", kind)).rejects.toMatchObject({ code: "authentication_busy", status: 503, extra: { retryAfter: 1 } });
  // Protected priority, both FIFOs, and an ordinary slot under protected load.
  await q.end("o0"); expect(q.starts.at(-1)).toBe("p0");
  await q.end("o1"); expect(q.starts.at(-1)).toBe("o2");
  await q.end("o2"); expect(q.starts.at(-1)).toBe("o3");
  await q.end("p0"); expect(q.starts.at(-1)).toBe("p1");
  for (let i = 3; i < 8; i++) await q.end(`o${i}`);
  await q.end("p1"); await Promise.all(pending);
  expect(q.starts).toEqual(["o0", "o1", "p0", "o2", "o3", "p1", "o4", "o5", "o6", "o7"]);
  expect(q.snapshot()).toEqual({ active: 0, activeProtected: 0, ordinary: 0, protected: 0 });
});

it("refuses a fourth simultaneous protected caller while the ordinary slot is idle, then admits its retry", async () => {
  const q = held(), pending = [q.run("p0", "protected"), q.run("p1", "protected"), q.run("p2", "protected")];
  expect(q.starts).toEqual(["p0"]);
  await expect(q.run("fourth", "protected")).rejects.toMatchObject({ code: "authentication_busy" });
  expect(q.snapshot()).toEqual({ active: 1, activeProtected: 1, ordinary: 0, protected: 2 });
  await q.end("p0"); pending.push(q.run("retry", "protected"));
  for (const id of ["p1", "p2", "retry"]) await q.end(id);
  await Promise.all(pending); expect(q.starts).toEqual(["p0", "p1", "p2", "retry"]);
});

it("expires either class at five seconds without starting its work", async () => {
  const q = held(), active = [q.run("o0"), q.run("o1")], waiting = [q.run("o2"), q.run("p0", "protected")];
  await vi.advanceTimersByTimeAsync(4999); expect(q.snapshot().ordinary).toBe(1); expect(q.snapshot().protected).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  for (const promise of waiting) await expect(promise).rejects.toMatchObject({ code: "authentication_busy" });
  expect(q.starts).toEqual(["o0", "o1"]);
  for (const id of ["o0", "o1"]) await q.end(id); await Promise.all(active);
  const retry = q.run("retry"); await q.end("retry"); await retry;
});

it("releases a failed native derivation and a synchronous submission failure", async () => {
  const q = held(), failed = q.run("bad", "protected"), next = q.run("next", "protected");
  q.finishes.get("bad")!.reject(new Error("native failure"));
  await expect(failed).rejects.toThrow("native failure"); expect(q.starts).toEqual(["bad", "next"]);
  await q.end("next"); await next;
  const submission = createDerivationAdmission();
  await expect(submission.run(() => { throw new Error("submission"); })).rejects.toThrow("submission");
  expect(submission.snapshot().active).toBe(0);
  expect(q.snapshot().active).toBe(0);
});

it("shares admission across independently loaded route bundles", async () => {
  const ends: (() => void)[] = [];
  const work = () => new Promise<void>(resolve => ends.push(resolve));
  const all = [withPasswordDerivation(work), withPasswordDerivation(work)];
  vi.resetModules(); const other = await import("./derivation-admission");
  for (let i = 0; i < 6; i++) all.push(other.withPasswordDerivation(work));
  expect(ends).toHaveLength(2);
  await expect(other.withPasswordDerivation(work)).rejects.toMatchObject({ code: "authentication_busy" });
  for (let i = 0; i < 8; i++) { ends[i](); await flush(); }
  await Promise.all(all);
});

it("maps busy to its exact private envelope and one-second advice", async () => {
  const q = held(), all = [q.run("p0", "protected"), q.run("p1", "protected"), q.run("p2", "protected")];
  const error = await q.run("fourth", "protected").catch(error => error);
  const response = authFailure(error);
  expect(response.status).toBe(503); expect(response.headers.get("retry-after")).toBe("1");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toEqual({ error: { code: "authentication_busy", message: "Authentication is busy. Try again shortly.", retryAfter: 1 } });
  for (const id of ["p0", "p1", "p2"]) await q.end(id); await Promise.all(all);
});
