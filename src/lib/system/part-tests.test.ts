import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import { POST } from "@/app/api/instance/parts/[part]/test/route";
import { admits, admittedTools, POLICY_REFUSAL_CODE } from "@/lib/assistant/policy";
import { runAssistant, resumeAssistant, type AssistantEvent } from "@/lib/assistant/loop";
import { PendingActionStore } from "@/lib/assistant/pending";
import { stubProvider } from "@/lib/assistant/providers/stub";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { requireAdmin } from "@/lib/auth/admin";
import { gateRequest } from "@/lib/auth/gate";
import { authenticateSession, createApiToken, issueSession } from "@/lib/auth/credentials";
import { getAccount } from "@/lib/metadata/accounts";
import * as metadata from "@/lib/metadata/db";
import { SETTING_CATALOGUE } from "@/lib/settings/catalogue";
import { keepRequestsOnThisMachine } from "@/lib/test-support/outside-requests";
import { testAccountScope } from "@/lib/test-support/accounts";
import { executeTool } from "@/lib/tools/execute";
import { buildTools } from "@/lib/tools/tools";
import { PARTS, PART_TEST_LIMITS, partTestWords, type PartTestAnswer } from "./part-test-answer";
import { testPart } from "./part-tests";

/**
 * A part's Test: one small fixed check of a part of this server as it is
 * configured now, under the part's own time limit. The data folder's
 * writes and removes one empty file, as the readiness check does; the
 * metadata database's takes the write lock, reads the schema's version and
 * rolls back. The answer is a closed shape, a pass with the time taken or
 * one reason, never a path, a program's output or an error's words. A
 * second Test of a part while one runs gets the same answer. Admins only;
 * nothing is kept and nothing leaves this machine, and the embedded
 * assistant asks first while the SQL and workflow assistants are never
 * offered it.
 */

keepRequestsOnThisMachine();

/** The data folder's readiness probe, counted, and held when a test says so. */
const probe = vi.hoisted(() => ({ calls: 0, hold: null as Promise<void> | null }));
vi.mock("@/lib/data-dir", async importOriginal => {
  const real = await importOriginal<typeof import("@/lib/data-dir")>();
  return { ...real, async ensureDataDir(dir: string) {
    probe.calls += 1;
    if (probe.hold) await probe.hold;
    return real.ensureDataDir(dir);
  } };
});

const ORIGIN = "http://instance.test";
const SCRATCH = path.join(process.cwd(), ".claude/test-data");

function partsFixture() {
  for (const definition of SETTING_CATALOGUE) if (definition.environment) vi.stubEnv(definition.environment, undefined);
  mkdirSync(SCRATCH, { recursive: true });
  const dir = mkdtempSync(path.join(SCRATCH, "parts-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
  // A file, so a second connection can hold its write lock.
  const file = path.join(dir, "metadata.sqlite");
  const db = metadata.open(file);
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  testAccountScope(db, "admin");
  testAccountScope(db, "member");
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
  const admin = issueSession(getAccount("admin", db)!, db, Date.now());
  const member = issueSession(getAccount("member", db)!, db, Date.now());
  const context = authenticateSession(admin.secret, db)!;
  const token = createApiToken(context, "Test parts", db);
  // The hourly credential sweep runs here, never inside a Test below.
  requireAdmin(context, db, Date.now());
  return { db, dir, file, admin, member, token,
    close() { db.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); } };
}

let f: ReturnType<typeof partsFixture>;
/** Every answer a Test gave in this file, searched after each test. */
let seen: unknown[] = [];
/** Folders this file made unwritable, given back before they are removed. */
let locked: string[] = [];

beforeEach(() => {
  f = partsFixture();
  probe.calls = 0; probe.hold = null;
  seen = []; locked = [];
});
afterEach(() => {
  try {
    // No answer holds a path, a file name or an error's words.
    const text = JSON.stringify(seen);
    for (const word of [f.dir, SCRATCH, ".dezfil-write-probe", "metadata.sqlite", "EACCES", "permission", "not writable",
      "SQLITE", "locked", "database is", "Error"]) expect(text, `an answer holds ${word}`).not.toContain(word);
  } finally {
    probe.hold = null;
    for (const folder of locked) { chmodSync(folder, 0o700); rmSync(folder, { recursive: true, force: true }); }
    f.close();
  }
});

const ADMIN = () => ({ cookie: `dezfil_session=${f.admin.secret}`, origin: ORIGIN });
function request(part: string, headers: Record<string, string> = ADMIN()) {
  return socketRequest(new Request(`${ORIGIN}/api/instance/parts/${part}/test`, { method: "POST", headers }));
}
async function runTest(part: string, headers?: Record<string, string>) {
  const response = await POST(request(part, headers), { params: Promise.resolve({ part }) });
  const body = await response.json() as Record<string, unknown>;
  seen.push(body);
  return { status: response.status, cache: response.headers.get("cache-control"), body };
}

/** Every file in the data folder by its bytes' digest; the metadata
 * database's own files by name alone unless asked, since every signed-in
 * request renews its credential there. Its `-shm` file is the log's index
 * in shared memory, where a reader marks its place: by name alone always. */
function files(database = false): Record<string, string> {
  return Object.fromEntries(readdirSync(f.dir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
    .map(entry => path.relative(f.dir, path.join(entry.parentPath, entry.name)))
    .map(file => [file, file.startsWith("metadata.sqlite") && (!database || file.endsWith("-shm")) ? "the database"
      : createHash("sha256").update(readFileSync(path.join(f.dir, file))).digest("hex")]).sort());
}
/** The admin's own context, for a Test asked without a request. */
const adminContext = () => authenticateSession(f.admin.secret, f.db)!;
const stored = () => ({
  settings: f.db.prepare("SELECT key, value FROM workspace_settings ORDER BY key").all(),
  version: f.db.pragma("user_version", { simple: true }),
});

describe("the data folder's Test", () => {
  it("writes and removes one empty file, passing with its time, private and no-store; the folder and the store unchanged", async () => {
    const before = { files: files(), stored: stored() };
    const answer = await runTest("data_folder");
    expect(answer).toEqual({ status: 200, cache: "private, no-store",
      body: { part: "data_folder", result: "passed", milliseconds: expect.any(Number) } });
    expect(answer.body.milliseconds).toBeGreaterThanOrEqual(0);
    expect(probe.calls).toBe(1);
    expect({ files: files(), stored: stored() }).toEqual(before);
  });

  it("fails, without its words, on a folder it cannot write", async () => {
    const folder = mkdtempSync(path.join(SCRATCH, "unwritable-"));
    chmodSync(folder, 0o500);
    locked.push(folder);
    vi.stubEnv("DEZFIL_DATA_DIR", folder);
    expect((await runTest("data_folder")).body).toEqual({ part: "data_folder", result: "failed", reason: "failed" });
    expect(readdirSync(folder)).toEqual([]);
    // Each answer is searched for the path, so this one is too.
    seen.push({ folder: "" });
    expect(JSON.stringify(seen)).not.toContain(folder);
  });

  it("answers past its limit when the probe does not finish within it", async () => {
    probe.hold = new Promise(() => {});
    const started = Date.now();
    expect((await runTest("data_folder")).body).toEqual({ part: "data_folder", result: "failed", reason: "timed_out" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(PART_TEST_LIMITS.data_folder * 1000 - 50);
    expect(Date.now() - started).toBeLessThan(PART_TEST_LIMITS.data_folder * 1000 + 2000);
  }, 15_000);
});

describe("the metadata database's Test", () => {
  it("takes the write lock, reads the schema's version and gives the lock back, passing with its time", async () => {
    const before = { files: files(), stored: stored() };
    const answer = await runTest("metadata_database");
    expect(answer).toEqual({ status: 200, cache: "private, no-store",
      body: { part: "metadata_database", result: "passed", milliseconds: expect.any(Number) } });
    expect(f.db.inTransaction).toBe(false);
    expect({ files: files(), stored: stored() }).toEqual(before);
    // The lock was given back: another connection takes it at once.
    const other = new Database(f.file, { timeout: 0 });
    try { other.exec("BEGIN IMMEDIATE"); other.exec("ROLLBACK"); } finally { other.close(); }
  });

  it("writes nothing: no row changes and the database and its log keep their bytes", async () => {
    const context = adminContext();
    const before = { files: files(true), changes: f.db.prepare("SELECT total_changes() AS n").get() };
    const answer = await testPart(context, "metadata_database");
    seen.push(answer);
    expect(answer).toMatchObject({ part: "metadata_database", result: "passed" });
    expect({ files: files(true), changes: f.db.prepare("SELECT total_changes() AS n").get() }).toEqual(before);
  });

  it("answers busy while a second connection holds the write lock past the database's wait, and passes once it lets go", async () => {
    // Asked without a request: a signed-in request renews its credential
    // under the same lock, so it would wait on it before the Test began.
    const context = adminContext();
    const other = new Database(f.file);
    try {
      other.exec("BEGIN IMMEDIATE");
      const started = Date.now();
      const busy = await testPart(context, "metadata_database");
      seen.push(busy);
      expect(busy).toEqual({ part: "metadata_database", result: "failed", reason: "busy" });
      // The database's own busy wait is the Test's limit.
      expect(Date.now() - started).toBeGreaterThanOrEqual(PART_TEST_LIMITS.metadata_database * 1000 - 50);
      expect(Date.now() - started).toBeLessThan(PART_TEST_LIMITS.metadata_database * 1000 + 2000);
      expect(f.db.inTransaction).toBe(false);
      other.exec("ROLLBACK");
      const passed = await testPart(context, "metadata_database");
      seen.push(passed);
      expect(passed).toMatchObject({ part: "metadata_database", result: "passed" });
    } finally { other.close(); }
  }, 20_000);

  it("fails when the store is not at the schema's version this server knows", async () => {
    f.db.pragma(`user_version = ${metadata.MIGRATIONS.length + 1}`);
    expect((await runTest("metadata_database")).body).toEqual({ part: "metadata_database", result: "failed", reason: "failed" });
    expect(f.db.pragma("user_version", { simple: true })).toBe(metadata.MIGRATIONS.length + 1);
  });
});

describe("the Test's road", () => {
  it("shares one run between concurrent Tests of a part", async () => {
    const held = Promise.withResolvers<void>();
    probe.hold = held.promise;
    const first = runTest("data_folder"), second = runTest("data_folder");
    await vi.waitFor(() => expect(probe.calls).toBeGreaterThanOrEqual(1));
    // Time for a second run to start, were one started.
    await new Promise(resolve => setTimeout(resolve, 100));
    held.resolve();
    const [one, two] = await Promise.all([first, second]);
    expect(probe.calls).toBe(1);
    expect(one.body).toMatchObject({ part: "data_folder", result: "passed" });
    expect(two.body).toEqual(one.body);
    // Once it has answered, the next Test runs anew.
    probe.hold = null;
    await runTest("data_folder");
    expect(probe.calls).toBe(2);
  });

  it("answers 404 for a part it does not know, running nothing", async () => {
    const answer = await runTest("kitchen_sink");
    expect(answer.status).toBe(404);
    expect(answer.cache).toBe("private, no-store");
    expect(answer.body).toEqual({ error: { code: "not_found", message: expect.any(String) } });
    expect(probe.calls).toBe(0);
  });
});

describe("who may Test", () => {
  it.each(["anonymous", "member", "member-token", "cross-origin-cookie"])("refuses %s at the gate and the handler, running nothing", async mode => {
    const memberToken = () => createApiToken(authenticateSession(f.member.secret, f.db)!, "Member", f.db).secret;
    const headers: Record<string, string> = mode === "anonymous" ? { origin: ORIGIN }
      : mode === "member" ? { cookie: `dezfil_session=${f.member.secret}`, origin: ORIGIN }
      : mode === "member-token" ? { authorization: `Bearer ${memberToken()}` }
      : { cookie: `dezfil_session=${f.admin.secret}`, origin: "https://elsewhere.test" };
    const status = mode === "anonymous" ? 401 : 403;
    for (const part of PARTS) {
      const gate = gateRequest(request(part, headers));
      const handler = await POST(request(part, headers), { params: Promise.resolve({ part }) });
      for (const response of [gate, handler]) {
        expect(response.status).toBe(status);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(await response.json()).toEqual({ error: { code: status === 401 ? "authentication_required" : "forbidden", message: expect.any(String) } });
      }
    }
    expect(probe.calls).toBe(0);
  });

  it("an admin's bearer token Tests directly", async () => {
    expect((await runTest("data_folder", { authorization: `Bearer ${f.token.secret}` })).body).toMatchObject({ part: "data_folder", result: "passed" });
  });
});

describe("the answer's words", () => {
  it("say the time taken, or the reason, and nothing else", () => {
    expect(partTestWords({ part: "data_folder", result: "passed", milliseconds: 4 })).toEqual({ passed: true, text: "Passed in 4 ms" });
    expect(partTestWords({ part: "metadata_database", result: "passed", milliseconds: 2 })).toEqual({ passed: true, text: "Answered in 2 ms" });
    expect(partTestWords({ part: "metadata_database", result: "passed", milliseconds: 1840 })).toEqual({ passed: true, text: "Answered in 1.8 s" });
    for (const part of PARTS) {
      for (const reason of ["not_found", "busy", "timed_out", "failed"] as const) {
        const words = partTestWords({ part, result: "failed", reason } as PartTestAnswer);
        expect(words.passed).toBe(false);
        expect(words.text.length).toBeGreaterThan(0);
        expect(words.text).not.toContain("—");
      }
      expect(partTestWords({ part, result: "failed", reason: "timed_out" }).text).toContain(`${PART_TEST_LIMITS[part]} seconds`);
    }
    expect(partTestWords({ part: "metadata_database", result: "failed", reason: "busy" }).text).toBe("Busy: another write holds the database.");
  });
});

describe("the generated tool", () => {
  const tool = () => buildTools().find(candidate => candidate.name === "test_part")!;
  const dispatch = (secret: string) => (async (input: RequestInfo | URL, init?: RequestInit) => {
    const incoming = input instanceof Request ? input : new Request(String(input), init);
    const headers = new Headers(incoming.headers);
    headers.set("authorization", `Bearer ${secret}`);
    return dispatchAssistantTestRoute(socketRequest(new Request(incoming, { headers })));
  }) as typeof fetch;

  it("is read-only and local, confirmed, never offered to the SQL and workflow assistants, and takes only the part", async () => {
    expect(tool()).toMatchObject({ path: "/api/instance/parts/{part}/test", method: "post", confirm: true,
      effects: { readOnly: true, writes: [] },
      mcp: { destructiveHint: false, openWorldHint: false } });
    expect(tool().effects.reachesOutside).toBeUndefined();
    expect(Object.keys(tool().inputSchema.properties)).toEqual(["part"]);
    expect(admits("read_only", tool())).toBe(false);
    // Confirmation is what keeps it out: the same operation unconfirmed is admitted.
    expect(admits("read_only", { ...tool(), confirm: false })).toBe(true);
    expect(admittedTools("read_only")).not.toContain(tool());
    expect(admittedTools("full")).toContain(tool());

    const member = createApiToken(authenticateSession(f.member.secret, f.db)!, "Member", f.db).secret;
    expect((await executeTool(tool(), { part: "data_folder" }, ORIGIN, dispatch(member))).status).toBe(403);
    expect(probe.calls).toBe(0);
    const tested = await executeTool(tool(), { part: "data_folder" }, ORIGIN, dispatch(f.token.secret));
    expect(tested.status).toBe(200);
    seen.push(tested.body);
    expect(tested.body).toMatchObject({ part: "data_folder", result: "passed" });
  });

  const turn = async (context: Parameters<typeof runAssistant>[1]["context"]) => {
    const pending = new PendingActionStore();
    const provider = stubProvider([
      { text: "", toolCalls: [{ id: "test-folder", name: "test_part", args: { part: "data_folder" } }] },
      { text: "Done.", toolCalls: [] },
    ]);
    const sent: string[] = [];
    const deps = { scope: testAccountScope(f.db, "admin"), baseUrl: ORIGIN, pending,
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const incoming = input instanceof Request ? input : new Request(String(input), init);
        sent.push(`${incoming.method} ${new URL(incoming.url).pathname}`);
        return dispatch(f.token.secret)(incoming);
      }) as typeof fetch };
    const events: AssistantEvent[] = [];
    for await (const event of runAssistant(provider, { message: "Test the data folder", history: [], ...(context ? { context } : {}) }, deps)) events.push(event);
    seen.push(events);
    return { events, sent, pending, deps };
  };

  it("is refused to the SQL and workflow assistants before any request", async () => {
    for (const context of [{ page: "sql", draft: "", selection: null, lastExecution: null }, { page: "workflow", recipeId: "r", selectedStepId: null, lastRunId: null }] as const) {
      const { events, sent } = await turn(context);
      expect(events.find(event => event.type === "tool_result")).toMatchObject({ tool: "test_part", ok: false, outcome: "refused",
        body: { error: { code: POLICY_REFUSAL_CODE } } });
      expect(sent.filter(call => call.includes("/api/instance/"))).toEqual([]);
    }
    expect(probe.calls).toBe(0);
  });

  it("is confirmed by the embedded assistant through its declared words before it runs", async () => {
    const { events, sent, pending, deps } = await turn(undefined);
    const question = events.find(event => event.type === "confirm_required");
    if (question?.type !== "confirm_required") throw new Error("expected a confirmation");
    expect(question.confirmation).toEqual({ target: "Test the data_folder part of this server?",
      consequence: "This server runs one small fixed check on that part. Nothing is saved and nothing is sent outside this server." });
    expect(sent.filter(call => call.includes("/api/instance/"))).toEqual([]);
    expect(probe.calls).toBe(0);

    const parked = pending.claim(deps.scope, question.id, "approved")!;
    const done: AssistantEvent[] = [];
    for await (const event of resumeAssistant(parked, true, deps)) done.push(event);
    seen.push(done);
    expect(done).toContainEqual(expect.objectContaining({ type: "tool_result", tool: "test_part", ok: true,
      body: expect.objectContaining({ part: "data_folder", result: "passed" }) }));
    expect(sent).toContain("POST /api/instance/parts/data_folder/test");
    expect(probe.calls).toBe(1);
  });
});
