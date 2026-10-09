import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { POST } from "@/app/api/instance/parts/[part]/test/route";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { connectQueryInstance, engineStateForTests, h3Available, hasQueryInstance, queryEngineExtensions, resetQueryInstance } from "@/lib/duckdb";
import { keepRequestsOnThisMachine } from "@/lib/test-support/outside-requests";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";
import { PART_TEST_LIMITS, type PartTestAnswer } from "./part-test-answer";
import { testPart } from "./part-tests";

/**
 * The query engine's Test: one fixed spatial question, with a known answer,
 * on a connection of the engine that runs people's SQL. A cold engine is
 * started for it loading only the extensions already installed: the Test
 * installs nothing, so without the spatial extension it answers not found
 * and leaves the engine unstarted for the next query to start as it always
 * has; an optional extension missing stays off until the next start, and
 * the engine records what it loaded.
 *
 * The engine downloads extensions with its own client, which the
 * outside-requests guard cannot see. Every test here points the engine's
 * extension repository at a loopback fixture that records each request, so
 * an install, wanted or seeded, reaches only this machine.
 */

keepRequestsOnThisMachine();

/** The deployment's own extension folder, as the environment gave it
 * before a fixture cleared it; unset, the engine's default. */
const REAL_EXTENSION_DIR = process.env.DUCKDB_EXTENSION_DIR;
const SCRATCH = path.join(process.cwd(), ".claude/test-data");

let repository: Server;
/** Every request the repository fixture received. */
let fetched: string[] = [];
let repositoryUrl = "";

/** Where each extension is installed in the real folder, read from the
 * engine's own listing, which reaches nothing. */
async function installedFiles(): Promise<Record<string, string | null>> {
  const instance = await DuckDBInstance.create(":memory:", REAL_EXTENSION_DIR ? { extension_directory: REAL_EXTENSION_DIR } : {});
  const conn = await instance.connect();
  try {
    const rows = (await conn.runAndReadAll("SELECT extension_name, installed, install_path FROM duckdb_extensions() WHERE extension_name IN ('spatial', 'h3')")).getRows();
    return Object.fromEntries(rows.map(([name, installed, file]) => [String(name), installed ? String(file) : null]));
  } finally { conn.disconnectSync(); instance.closeSync(); }
}

let installed: Record<string, string | null> = {};

beforeAll(async () => {
  installed = await installedFiles();
  // A fresh machine installs the two from the engine's own repository on
  // its first start, as every engine test does; where both are installed
  // already, as here, nothing is fetched.
  if (!installed.spatial || !installed.h3) {
    const conn = await connectQueryInstance();
    conn.disconnectSync();
    resetQueryInstance();
    installed = await installedFiles();
  }
  repository = createServer((req, res) => { fetched.push(`${req.method} ${req.url}`); res.statusCode = 404; res.end(); });
  await new Promise<void>(resolve => repository.listen(0, "127.0.0.1", () => resolve()));
  repositoryUrl = `http://127.0.0.1:${(repository.address() as AddressInfo).port}/repository`;
});
afterAll(async () => {
  repository.closeAllConnections();
  await new Promise<void>(resolve => repository.close(() => resolve()));
});

let f: ReturnType<typeof instanceSettingsFixture>;
let seen: unknown[] = [];
let folders: string[] = [];

/** A scratch extension folder: empty, or holding the named installed
 * extensions as links to their files, laid out as the engine lays them. */
function extensionFolder(...names: string[]): string {
  mkdirSync(SCRATCH, { recursive: true });
  const folder = mkdtempSync(path.join(SCRATCH, "extensions-"));
  folders.push(folder);
  for (const name of names) {
    const file = installed[name]!;
    const place = path.join(folder, ...file.split(path.sep).slice(-3, -1));
    mkdirSync(place, { recursive: true });
    for (const suffix of ["", ".info"]) symlinkSync(file + suffix, path.join(place, path.basename(file) + suffix));
  }
  return folder;
}
const contents = (folder: string) => readdirSync(folder, { recursive: true }).map(String).sort();

beforeEach(() => {
  f = instanceSettingsFixture();
  vi.stubEnv("DUCKDB_EXTENSION_DIR", REAL_EXTENSION_DIR);
  vi.stubEnv("DEZFIL_TEST_EXTENSION_REPOSITORY", repositoryUrl);
  fetched = []; seen = []; folders = [];
  resetQueryInstance();
});
afterEach(() => {
  try {
    // No answer holds a path, the engine's words or an extension's file.
    const text = JSON.stringify(seen);
    for (const word of [SCRATCH, "IO Error", "Extension", "duckdb_extension", "spatial", "Error"]) expect(text, `an answer holds ${word}`).not.toContain(word);
    // Whatever was fetched, it was fetched here.
    expect(fetched.every(request => request.startsWith("GET /repository/"))).toBe(true);
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetQueryInstance();
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
    f.close();
  }
});

async function test(): Promise<PartTestAnswer> {
  const answer = await testPart(f.context, "query_engine", f.db);
  seen.push(answer);
  return answer;
}

describe("the query engine's Test", () => {
  it("starts a cold engine and passes with its time, then passes warm on the same engine", async () => {
    expect(hasQueryInstance()).toBe(false);
    expect(queryEngineExtensions()).toBeNull();
    const before = engineStateForTests().instances;
    expect(await test()).toEqual({ part: "query_engine", result: "passed", milliseconds: expect.any(Number) });
    expect(hasQueryInstance()).toBe(true);
    expect(queryEngineExtensions()).toEqual(["spatial", "h3", "json"]);
    expect(engineStateForTests().instances).toBe(before + 1);
    expect(await test()).toEqual({ part: "query_engine", result: "passed", milliseconds: expect.any(Number) });
    expect(engineStateForTests().instances).toBe(before + 1);
    expect(engineStateForTests().leases).toBe(0);
    expect(fetched).toEqual([]);
  });

  it("joins an engine already starting rather than starting a second", async () => {
    const before = engineStateForTests().instances;
    const query = connectQueryInstance();
    const answer = test();
    (await query).disconnectSync();
    expect(await answer).toMatchObject({ part: "query_engine", result: "passed" });
    expect(engineStateForTests().instances).toBe(before + 1);
  });

  it("is reached through the route, as configured now", async () => {
    const response = await POST(socketRequest(new Request("http://instance.test/api/instance/parts/query_engine/test", {
      method: "POST", headers: { cookie: `dezfil_session=${f.admin.secret}`, origin: "http://instance.test" } })), { params: Promise.resolve({ part: "query_engine" }) });
    const body = await response.json();
    seen.push(body);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body).toMatchObject({ part: "query_engine", result: "passed" });
  });

  it("without the spatial extension installed answers not found, fetching and adding nothing, and leaves the engine for the next query to start as it always has", async () => {
    const empty = extensionFolder();
    vi.stubEnv("DUCKDB_EXTENSION_DIR", empty);
    const answer = await test();
    // Nothing was asked of the repository and nothing landed in the folder.
    expect(fetched).toEqual([]);
    expect(contents(empty)).toEqual([]);
    expect(answer).toEqual({ part: "query_engine", result: "failed", reason: "not_found" });
    expect(hasQueryInstance()).toBe(false);
    expect(queryEngineExtensions()).toBeNull();
    expect(engineStateForTests().leases).toBe(0);

    // The next query starts the engine as it always has, installing what
    // is missing: here from the loopback repository, which has nothing.
    await expect(connectQueryInstance()).rejects.toThrow();
    expect(fetched.some(request => /^GET \/repository\/.+\/spatial\.duckdb_extension/.test(request))).toBe(true);
    expect(hasQueryInstance()).toBe(false);
    // With spatial installed, the next query starts it.
    vi.stubEnv("DUCKDB_EXTENSION_DIR", REAL_EXTENSION_DIR);
    (await connectQueryInstance()).disconnectSync();
    expect(hasQueryInstance()).toBe(true);
    expect(queryEngineExtensions()).toEqual(["spatial", "h3", "json"]);
  });

  it("with hexagons not installed passes, leaving them off, and lists what loaded", async () => {
    const folder = extensionFolder("spatial");
    const held = contents(folder);
    vi.stubEnv("DUCKDB_EXTENSION_DIR", folder);
    expect(await test()).toMatchObject({ part: "query_engine", result: "passed" });
    expect(queryEngineExtensions()).toEqual(["spatial", "json"]);
    expect(h3Available()).toBe(false);
    expect(fetched).toEqual([]);
    expect(contents(folder)).toEqual(held);
  });

  it("answers past its limit when the question does not finish within it, interrupting it", async () => {
    // Warm first, so the limit falls on the question.
    expect(await test()).toMatchObject({ result: "passed" });
    const asked = Promise.withResolvers<void>();
    const ask = DuckDBConnection.prototype.runAndReadAll;
    vi.spyOn(DuckDBConnection.prototype, "runAndReadAll").mockImplementationOnce(function (this: DuckDBConnection) {
      asked.resolve();
      // A question that would run for minutes.
      return ask.call(this, "SELECT count(*) FROM range(1000000) a, range(1000000) b");
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const answer = test();
    await asked.promise;
    await vi.advanceTimersByTimeAsync(PART_TEST_LIMITS.query_engine * 1000 + 1000);
    expect(await answer).toEqual({ part: "query_engine", result: "failed", reason: "timed_out" });
    vi.useRealTimers();
    // The question was interrupted: its connection goes back within moments.
    await vi.waitFor(() => expect(engineStateForTests().leases).toBe(0), { timeout: 5000 });
    expect(await test()).toMatchObject({ result: "passed" });
  });
});
