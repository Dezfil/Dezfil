import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { connectQueryInstance, queryEngineStanding, resetQueryInstance } from "@/lib/duckdb";
import { GET } from "./route";

// Engine failure-injection tests. HTTP provenance has its own suite.
vi.mock("@/lib/auth/ingress.mjs", () => ({ requireIngress: vi.fn() }));

/**
 * Readiness answers for the engine that runs people's SQL once something
 * has started it: an engine no query has started is left alone; a running
 * one is asked a trivial statement, and a failing statement reads as not
 * ready while a slow one reads as busy; an engine whose last start failed
 * reads as not ready, and readiness starts it again at most once per
 * thirty seconds, so an instance taken out of rotation recovers on its own.
 */

let dir: string;
/** Each test's own clock, an hour from the last, so no retry spacing from
 * one test reaches the next. */
let clock = Date.parse("2026-10-16T00:00:00Z");
beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  resetQueryInstance();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(clock += 3_600_000);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

const create = DuckDBInstance.create.bind(DuckDBInstance);
/** Engine starts, failing while `failing.now` holds, counted. */
function starts(failing: { now: boolean }) {
  return vi.spyOn(DuckDBInstance, "create").mockImplementation(async (...args: Parameters<typeof create>) => {
    if (failing.now) throw new Error('IO Error: Extension "/opt/dezfil/spatial.duckdb_extension" not found');
    return create(...args);
  });
}

/** A query's start that fails, as the first query after a broken boot. */
async function failedStart() {
  await expect(connectQueryInstance()).rejects.toThrow("not found");
}

async function readiness() {
  const res = await GET();
  return { status: res.status, body: await res.json() as { status: string; reason?: string } };
}

function expectUnready(answer: { status: number; body: { status: string; reason?: string } }) {
  expect(answer.status).toBe(503);
  expect(answer.body).toEqual({ status: "unready", reason: "The query engine that runs SQL is not answering." });
  // None of the engine's own words, which can carry a path, reach the wire.
  expect(JSON.stringify(answer.body)).not.toContain("/opt");
}

describe("readiness and the query engine", () => {
  it("starts nothing for an engine no query has started, and answers on storage alone", async () => {
    const started = starts({ now: false });
    expect(await readiness()).toEqual({ status: 200, body: { status: "ready" } });
    expect(started).not.toHaveBeenCalled();
    expect(existsSync(path.join(dir, "data", "tiles"))).toBe(false);
  });

  it("answers ready for a running engine that answers", async () => {
    (await connectQueryInstance()).disconnectSync();
    expect(await readiness()).toEqual({ status: 200, body: { status: "ready" } });
  });

  it("answers not ready once a start has failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    starts({ now: true });
    await failedStart();
    expectUnready(await readiness());
  });

  it("holds not ready while a query's start of a failed engine runs past the limit, and is ready once it succeeds", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = { now: true };
    const slow = Promise.withResolvers<void>();
    const started = vi.spyOn(DuckDBInstance, "create").mockImplementation(async (...args: Parameters<typeof create>) => {
      if (failing.now) throw new Error('IO Error: Extension "/opt/dezfil/spatial.duckdb_extension" not found');
      await slow.promise;
      return create(...args);
    });
    await failedStart();
    // The cause clears and a query starts the engine again; the start is slow.
    failing.now = false;
    const retried = connectQueryInstance();
    // Should an assertion fail first, the start still settles, so no test
    // after this one inherits a start under way.
    onTestFinished(async () => { slow.resolve(); await retried.then((conn) => conn.disconnectSync(), () => {}); });
    expectUnready(await readiness());
    // Readiness joined the query's start rather than making one of its own.
    expect(started).toHaveBeenCalledTimes(2);
    slow.resolve();
    await retried;
    let answer = await readiness();
    for (let i = 0; i < 20 && answer.status !== 200; i++) answer = await readiness();
    expect(answer).toEqual({ status: 200, body: { status: "ready" } });
    expect(started).toHaveBeenCalledTimes(2);
  });

  it("reads a recovered engine as running while readiness's own connection is still queued", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = { now: true };
    const started = starts(failing);
    await failedStart();
    failing.now = false;
    // The first connection the started engine hands out, readiness's own,
    // waits behind other work; the start's own setup connection does not.
    const queued = Promise.withResolvers<void>();
    onTestFinished(() => queued.resolve());
    const connect = DuckDBInstance.prototype.connect;
    let hold = true;
    vi.spyOn(DuckDBInstance.prototype, "connect").mockImplementation(function (this: DuckDBInstance) {
      if (hold && queryEngineStanding() === "running") {
        hold = false;
        return queued.promise.then(() => connect.call(this));
      }
      return connect.call(this);
    });
    // Readiness starts the failed engine again; the start succeeds, but its
    // connection is still queued when the limit passes.
    expectUnready(await readiness());
    expect(started).toHaveBeenCalledTimes(2);
    expect(queryEngineStanding()).toBe("running");
    // A query is served meanwhile.
    (await connectQueryInstance()).disconnectSync();
    // The engine is running, so readiness asks it, whatever its own
    // queued connection is doing.
    expect(await readiness()).toEqual({ status: 200, body: { status: "ready" } });
    expect(started).toHaveBeenCalledTimes(2);
  });

  it("answers not ready when a running engine's statement fails, and gives its connection back", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    (await connectQueryInstance()).disconnectSync();
    const run = DuckDBConnection.prototype.runAndReadAll;
    vi.spyOn(DuckDBConnection.prototype, "runAndReadAll").mockImplementation(function (this: DuckDBConnection, sql: string, ...rest) {
      if (sql === "SELECT 1") return Promise.reject(new Error("IO Error: /opt/dezfil/tables is gone"));
      return run.call(this, sql, ...rest);
    });
    const disconnect = vi.spyOn(DuckDBConnection.prototype, "disconnectSync");
    expectUnready(await readiness());
    expect(disconnect).toHaveBeenCalled();
  });

  it("answers ready when a running engine is too busy to answer in time, interrupting what it asked", async () => {
    (await connectQueryInstance()).disconnectSync();
    const answered = Promise.withResolvers<void>();
    const run = DuckDBConnection.prototype.runAndReadAll;
    vi.spyOn(DuckDBConnection.prototype, "runAndReadAll").mockImplementation(function (this: DuckDBConnection, sql: string, ...rest) {
      // The statement waits behind other work, then answers.
      if (sql === "SELECT 1") return answered.promise.then(() => run.call(this, sql, ...rest));
      return run.call(this, sql, ...rest);
    });
    const interrupt = vi.spyOn(DuckDBConnection.prototype, "interrupt");
    const disconnect = vi.spyOn(DuckDBConnection.prototype, "disconnectSync");
    const begun = performance.now();
    expect(await readiness()).toEqual({ status: 200, body: { status: "ready" } });
    expect(performance.now() - begun).toBeLessThan(4_000);
    expect(interrupt).toHaveBeenCalled();
    // The connection goes back once the statement settles, not before.
    expect(disconnect).not.toHaveBeenCalled();
    answered.resolve();
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalled());
  });

  it("starts a failed engine again at most once per thirty seconds, and is ready once a start succeeds", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = { now: true };
    const started = starts(failing);
    await failedStart();
    expect(started).toHaveBeenCalledTimes(1);
    // The first readiness after the failure starts it again; it still fails.
    expectUnready(await readiness());
    expect(started).toHaveBeenCalledTimes(2);
    // The cause clears. Inside the thirty seconds nothing is started.
    failing.now = false;
    vi.setSystemTime(Date.now() + 29_000);
    expectUnready(await readiness());
    expect(started).toHaveBeenCalledTimes(2);
    // Past them, one start, and ready once it has answered.
    vi.setSystemTime(Date.now() + 1_000);
    let answer = await readiness();
    for (let i = 0; i < 20 && answer.status !== 200; i++) answer = await readiness();
    expect(answer).toEqual({ status: 200, body: { status: "ready" } });
    expect(started).toHaveBeenCalledTimes(3);
  });
});
