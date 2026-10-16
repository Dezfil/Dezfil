import { testAccountScope, testAccountRequest } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { INTEGER, type DuckDBConnection } from "@duckdb/node-api";

const fixture = vi.hoisted(() => ({ acquire: vi.fn(), resolve: vi.fn(), side: vi.fn(), sideRun: vi.fn(), sides: [] as string[][] }));
vi.mock("@/lib/duckdb", () => ({ withConnection: async (work: (conn: DuckDBConnection) => Promise<unknown>) => {
  const conn = await fixture.acquire();
  try { return await work(conn); } finally { conn.disconnectSync(); }
}, withSideConnection: async (work: (conn: DuckDBConnection) => Promise<unknown>) => {
  // The connection outside the operation that cancels a held statement on the source.
  await fixture.side();
  const sql: string[] = []; fixture.sides.push(sql);
  return work({ run: async (statement: string) => { sql.push(statement); await fixture.sideRun(statement); return {}; } } as unknown as DuckDBConnection);
} }));
vi.mock("@/lib/net/egress", () => ({ resolveAllowed: (...args: unknown[]) => fixture.resolve(...args) }));
import { POST } from "@/app/api/connections/postgis/[id]/preview/route";
import { closeMetadataDb } from "@/lib/metadata/db";
import { getConnection, insertConnection } from "@/lib/metadata/connections";
import { resetSecretKeyCache } from "@/lib/secrets";
import { testConnection, browseRemoteTables, withPg } from "./access";

const target = { id: "c1", name: "Source", host: "db.example.org", port: 5432, database: "gis", username: "reader", password: "fixture-only", ssl: false };
type Stage = "load" | "attach" | "version" | "extension" | "columns" | "rows" | "detach";
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function connection(hold?: Stage, failure?: Stage) {
  const entered = deferred(); const release = deferred();
  const stages: Stage[] = []; const sql: string[] = [];
  async function execute(statement: string) {
    const stage: Stage = statement.startsWith("INSTALL") ? "load" : statement.startsWith("ATTACH") ? "attach"
      : statement.startsWith("DETACH") ? "detach" : statement.includes("SELECT version()") ? "version"
      : statement.includes("pg_extension") ? "extension" : statement.includes("information_schema.columns") ? "columns" : "rows";
    sql.push(statement); stages.push(stage);
    if (stage === hold) { entered.resolve(); await release.promise; }
    if (stage === failure) throw new Error("IO Error: source query failed: ERROR:  canceling statement due to statement timeout\n");
    const rows = stage === "version" ? [{ v: "PostgreSQL fixture" }] : stage === "extension" ? [{ v: "3.4" }]
      : stage === "columns" ? [{ column_name: "id", udt_name: "int4" }] : [{ id: 7 }];
    return { getRowObjects: () => rows, getRowObjectsJson: () => rows };
  }
  const prepare = vi.fn(async () => ({ columnCount: 1, columnName: () => "id", columnType: () => INTEGER, destroySync: vi.fn() }));
  const stream = vi.fn(async (statement: string) => {
    await execute(statement);
    let read = false;
    return { deduplicatedColumnNames: () => ["id"], fetchChunk: async () => {
      if (read) return null;
      read = true;
      return { rowCount: 1, getColumnVector: () => ({ getItem: () => 7, type: INTEGER }) };
    } };
  });
  return { stages, sql, entered, release, prepare, stream, run: vi.fn(execute), runAndReadAll: vi.fn(execute), interrupt: vi.fn(), disconnectSync: vi.fn() };
}
function preview(controller = new AbortController()) {
  return POST(testAccountRequest(new Request("http://localhost/api/connections/postgis/c1/preview", {
    method: "POST", body: JSON.stringify({ schema: "public", table: "attrs" }), signal: controller.signal,
  })), { params: Promise.resolve({ id: target.id }) });
}
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(process.cwd(), ".tmp-preview-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
  closeMetadataDb(); resetSecretKeyCache(); insertConnection(testAccountScope(), target);
  fixture.acquire.mockReset().mockImplementation(async () => connection());
  fixture.resolve.mockReset().mockResolvedValue(["192.0.2.1"]);
  fixture.side.mockReset(); fixture.sideRun.mockReset(); fixture.sides.length = 0;
});
afterEach(() => { closeMetadataDb(); resetSecretKeyCache(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

// the preview records no connection health, so a connection inserted
// unchecked stays unchecked whatever stage the attachment reached. The
// rows below assert that across every stage, including the two
// (columns, rows) whose health observation used to be persisted.
describe("actual preview route owns its attachment", () => {
  it("starts no source stage for an already departed caller", async () => {
    const controller = new AbortController(); controller.abort();
    const response = await preview(controller);
    expect(response.status).toBe(499); expect(await response.text()).toBe("");
    expect(fixture.resolve).not.toHaveBeenCalled(); expect(fixture.acquire).not.toHaveBeenCalled();
    expect(getConnection(testAccountScope(), target.id)?.status).toBe("never_checked");
  });
  it.each(["egress", "acquisition"])("stops after a departed %s wait without starting a source stage", async (stage) => {
    const wait = deferred(); const entered = deferred(); const conn = connection();
    const holder = async () => { entered.resolve(); await wait.promise; return stage === "egress" ? ["192.0.2.1"] : conn; };
    if (stage === "egress") fixture.resolve.mockImplementation(holder); else fixture.acquire.mockImplementation(holder);
    const controller = new AbortController(); const pending = preview(controller);
    await entered.promise; controller.abort(); wait.resolve();
    const response = await pending;
    expect(response.status).toBe(499); expect(conn.stages).toEqual([]);
    if (stage === "egress") expect(fixture.acquire).not.toHaveBeenCalled();
    else expect(conn.disconnectSync).toHaveBeenCalledOnce();
  });
  it.each(["load", "attach", "version", "extension", "columns", "rows"] as Stage[])(
    "aborts during %s, drains native work and discards its late result", async (stage) => {
      const conn = connection(stage); fixture.acquire.mockResolvedValue(conn);
      const controller = new AbortController(); const pending = preview(controller);
      await conn.entered.promise; controller.abort();
      expect(conn.interrupt).toHaveBeenCalled();
      expect(conn.disconnectSync).not.toHaveBeenCalled();
      expect(conn.stages).not.toContain("detach");
      if (stage === "load" || stage === "attach") expect(fixture.side).not.toHaveBeenCalled();
      else {
        // The held statement is cancelled on the source from another
        // connection, without waiting for the blocked one.
        await vi.waitFor(() => expect(fixture.sides[0]?.some(sql => sql.includes("pg_cancel_backend"))).toBe(true));
        const identity = conn.sql.find(sql => sql.startsWith("ATTACH "))!.match(/application_name=''(dezfil_preview_[a-f0-9]+)''/)![1];
        const [load, attach, cancel] = fixture.sides[0];
        expect(load).toBe("LOAD postgres");
        expect(attach).toMatch(/application_name=''dezfil_cancel_[a-f0-9]+''/);
        expect(attach).toContain("connect_timeout=5");
        expect(attach).toContain("statement_timeout=5000");
        expect(cancel).toContain(`left(application_name, ${identity.length}) = ''${identity}''`);
        expect(cancel).toContain("pid <> pg_backend_pid()");
        expect(conn.stages).not.toContain("detach");
      }
      conn.release.resolve();
      const response = await pending;
      expect(response.status).toBe(499); expect(await response.text()).toBe("");
      expect(conn.stages.slice(conn.stages.indexOf(stage) + 1)).toEqual(stage === "load" ? [] : ["detach"]);
      expect(conn.disconnectSync).toHaveBeenCalledOnce();
      expect(getConnection(testAccountScope(), target.id)?.status).toBe("never_checked");
      // The cancelling attachment is detached before the operation settles.
      for (const sql of fixture.sides) expect(sql.at(-1)).toMatch(/^DETACH pg_cancel_[a-f0-9]+$/);
    },
  );
  // libpq stops at the first address that answers, which need not be the
  // server the attachment fell back to: each address is cancelled on its own.
  const sideAttachments = (sql: string[]) => sql.filter(statement => statement.startsWith("ATTACH ")).map(statement => ({
    statement, alias: statement.match(/ AS (pg_cancel_[a-f0-9]+) /)![1],
  }));
  const cancelledThrough = (sql: string[]) => sql.filter(statement => statement.includes("pg_cancel_backend")).map(statement => statement.match(/postgres_query\('(pg_cancel_[a-f0-9]+)'/)![1]);
  it("cancels on every address the attachment was handed, each through its own attachment", async () => {
    fixture.resolve.mockResolvedValue(["::1", "127.0.0.1"]);
    const conn = connection("version"); fixture.acquire.mockResolvedValue(conn);
    const controller = new AbortController(); const pending = preview(controller);
    let attached: ReturnType<typeof sideAttachments> = [];
    try {
      await conn.entered.promise; controller.abort();
      await vi.waitFor(() => expect(new Set(cancelledThrough(fixture.sides[0] ?? [])).size).toBe(2));
      const main = conn.sql.find(sql => sql.startsWith("ATTACH "))!;
      expect(main).toContain("host=''db.example.org,db.example.org''");
      expect(main).toContain("hostaddr=''::1,127.0.0.1''");
      attached = sideAttachments(fixture.sides[0]);
      expect(attached.map(({ statement }) => statement.match(/hostaddr=''([^']+)''/)![1])).toEqual(["::1", "127.0.0.1"]);
      for (const { statement } of attached) expect(statement).toContain("host=''db.example.org'' ");
      expect(new Set(cancelledThrough(fixture.sides[0]))).toEqual(new Set(attached.map(({ alias }) => alias)));
    } finally { conn.release.resolve(); }
    expect((await pending).status).toBe(499);
    expect(fixture.sides[0].filter(sql => sql.startsWith("DETACH ")).sort()).toEqual(attached.map(({ alias }) => `DETACH ${alias}`).sort());
  });
  it("skips an address whose cancelling attachment fails and still cancels through the others", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      fixture.resolve.mockResolvedValue(["::1", "127.0.0.1"]);
      fixture.sideRun.mockImplementation(async (statement: string) => {
        if (statement.startsWith("ATTACH ") && statement.includes("hostaddr=''::1''")) throw new Error("connection to server at \"::1\" failed: Connection refused");
      });
      const conn = connection("version"); fixture.acquire.mockResolvedValue(conn);
      const controller = new AbortController(); const pending = preview(controller);
      let reached: ReturnType<typeof sideAttachments>[number] | undefined;
      try {
        await conn.entered.promise; controller.abort();
        await vi.waitFor(() => expect(cancelledThrough(fixture.sides[0] ?? []).length).toBeGreaterThan(0));
        reached = sideAttachments(fixture.sides[0]).find(({ statement }) => statement.includes("hostaddr=''127.0.0.1''"));
        expect(reached).toBeDefined();
        expect(new Set(cancelledThrough(fixture.sides[0]))).toEqual(new Set([reached!.alias]));
      } finally { conn.release.resolve(); }
      expect((await pending).status).toBe(499);
      expect(fixture.sides[0].filter(sql => sql.startsWith("DETACH "))).toEqual([`DETACH ${reached!.alias}`]);
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });
  it("drops an address once a cancel through it fails and keeps trying the others", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      fixture.resolve.mockResolvedValue(["::1", "127.0.0.1"]);
      let failing: string | undefined;
      fixture.sideRun.mockImplementation(async (statement: string) => {
        if (statement.startsWith("ATTACH ") && statement.includes("hostaddr=''::1''")) failing = statement.match(/ AS (pg_cancel_[a-f0-9]+) /)![1];
        if (failing && statement.includes(`postgres_query('${failing}'`)) throw new Error("server closed the connection unexpectedly");
      });
      const conn = connection("version"); fixture.acquire.mockResolvedValue(conn);
      const controller = new AbortController(); const pending = preview(controller);
      try {
        await conn.entered.promise; controller.abort();
        const other = () => cancelledThrough(fixture.sides[0] ?? []).filter(alias => alias !== failing);
        await vi.waitFor(() => expect(other().length).toBeGreaterThanOrEqual(3));
        expect(cancelledThrough(fixture.sides[0]).filter(alias => alias === failing)).toHaveLength(1);
      } finally { conn.release.resolve(); }
      expect((await pending).status).toBe(499);
      expect(fixture.sides[0].filter(sql => sql.startsWith("DETACH "))).toHaveLength(2);
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });
  it("cancels through the first address at once and keeps every attempt inside one window", async () => {
    // Every address after the first hangs to its 5 s connect limit and fails;
    // the clock moves by that limit instead of the test waiting it out.
    const addresses = Array.from({ length: 8 }, (_, index) => `192.0.2.${index + 1}`);
    fixture.resolve.mockResolvedValue(addresses);
    const now = performance.now.bind(performance); let skew = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now() + skew);
    fixture.sideRun.mockImplementation(async (statement: string) => {
      if (statement.startsWith("ATTACH ") && !statement.includes("hostaddr=''192.0.2.1''")) { skew += 5_000; throw new Error("timeout expired"); }
    });
    const conn = connection("version"); fixture.acquire.mockResolvedValue(conn);
    const controller = new AbortController(); const pending = preview(controller);
    try {
      await conn.entered.promise;
      const started = performance.now(); controller.abort();
      await vi.waitFor(() => expect(cancelledThrough(fixture.sides[0] ?? []).length).toBeGreaterThan(0));
      const sql = fixture.sides[0], attaches = sql.filter(statement => statement.startsWith("ATTACH "));
      expect(attaches[0]).toContain("hostaddr=''192.0.2.1''");
      // The first cancel went out before any later address was tried.
      expect(sql.findIndex(statement => statement.includes("pg_cancel_backend"))).toBeLessThan(attaches.length > 1 ? sql.indexOf(attaches[1]) : sql.length);
      await vi.waitFor(() => expect(sql.some(statement => statement.startsWith("DETACH "))).toBe(true), { timeout: 5_000 });
      // The statement still runs, so only the window ends the cancellation:
      // within it plus one connect limit, with the addresses past it untried.
      expect(performance.now() - started).toBeLessThanOrEqual(20_000 + 5_000);
      expect(sql.filter(statement => statement.startsWith("ATTACH ")).length).toBeLessThan(addresses.length);
      expect(sql.filter(statement => statement.startsWith("DETACH "))).toEqual([`DETACH ${sideAttachments(sql)[0].alias}`]);
    } finally { conn.release.resolve(); clock.mockRestore(); }
    expect((await pending).status).toBe(499);
  });
  it("keeps the departure's answer when the cancellation on the source fails, and logs it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const conn = connection("rows"); fixture.acquire.mockResolvedValue(conn);
      fixture.side.mockRejectedValue(new Error("Unable to connect to Postgres at host=db.example.org password=fixture-only"));
      const controller = new AbortController(); const pending = preview(controller);
      await conn.entered.promise; controller.abort();
      await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
      conn.release.resolve();
      const response = await pending;
      expect(response.status).toBe(499); expect(await response.text()).toBe("");
      expect(String(warn.mock.calls[0])).not.toContain("fixture-only");
      expect(warn).toHaveBeenCalledOnce();
    } finally { warn.mockRestore(); }
  });
  it("discards a result when departure occurs during teardown", async () => {
    const conn = connection("detach"); fixture.acquire.mockResolvedValue(conn);
    const controller = new AbortController(); const pending = preview(controller);
    await conn.entered.promise; controller.abort(); conn.release.resolve();
    expect((await pending).status).toBe(499);
    expect(conn.disconnectSync).toHaveBeenCalledOnce();
    expect(getConnection(testAccountScope(), target.id)?.status).toBe("never_checked");
  });
  it("interrupts only the departing preview while a sibling completes", async () => {
    const first = connection("rows"), second = connection();
    fixture.acquire.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const controller = new AbortController(); const pending = preview(controller);
    await first.entered.promise; controller.abort();
    const sibling = await preview();
    expect(sibling.status).toBe(200); expect(second.interrupt).not.toHaveBeenCalled();
    expect(first.interrupt).toHaveBeenCalled();
    first.release.resolve(); expect((await pending).status).toBe(499);
    expect(first.disconnectSync).toHaveBeenCalledOnce(); expect(second.disconnectSync).toHaveBeenCalledOnce();
    // Only the departing attachment's statements are cancelled on the source.
    const identity = (c: ReturnType<typeof connection>) => c.sql.find(sql => sql.startsWith("ATTACH "))!.match(/application_name=''(dezfil_preview_[a-f0-9]+)''/)![1];
    expect(fixture.sides).toHaveLength(1);
    expect(fixture.sides[0].join("\n")).toContain(identity(first));
    expect(fixture.sides[0].join("\n")).not.toContain(identity(second));
  });
  it.each(["attach", "version", "extension", "columns", "rows"] as Stage[])(
    "classifies the source ceiling during %s as 408 without recording failure", async (stage) => {
      const conn = connection(undefined, stage); fixture.acquire.mockResolvedValue(conn);
      const response = await preview();
      expect(response.status).toBe(408);
      expect(await response.json()).toEqual({ error: { code: "query_timeout", message: "The PostGIS source query took too long." } });
      expect(getConnection(testAccountScope(), target.id)?.status).toBe("never_checked");
      expect(conn.disconnectSync).toHaveBeenCalledOnce();
    },
  );
  it("lets caller departure win over a simultaneous source timeout", async () => {
    const conn = connection("rows", "rows"); fixture.acquire.mockResolvedValue(conn);
    const controller = new AbortController(); const pending = preview(controller);
    await conn.entered.promise; controller.abort(); conn.release.resolve();
    expect((await pending).status).toBe(499);
    expect(getConnection(testAccountScope(), target.id)?.status).toBe("never_checked");
  });
  it("carries a unique preview identity and ceiling in source startup options for every operation", async () => {
    const connections = [connection(), connection(), connection(), connection(), connection()];
    fixture.acquire.mockImplementation(async () => connections.shift());
    const captured = [...connections];
    expect((await preview()).status).toBe(200); expect((await preview()).status).toBe(200);
    await testConnection(target); await browseRemoteTables(target); await withPg(target, async () => {});
    const attachments = captured.map((c) => c.sql.find((s) => s.startsWith("ATTACH "))!);
    for (const attach of attachments.slice(0, 2)) {
      expect(attach).toContain("options=''-c statement_timeout=30000''");
      expect(attach).toMatch(/application_name=''dezfil_preview_[a-f0-9]+''/);
    }
    expect(attachments[0].match(/application_name=([^ ]+)/)?.[0]).not.toBe(attachments[1].match(/application_name=([^ ]+)/)?.[0]);
    for (const attach of attachments.slice(2)) { expect(attach).toContain("statement_timeout=30000"); expect(attach).toMatch(/application_name=''dezfil_source_[a-f0-9]+''/); }
  });
});

import { PgSourceOwner } from "./source-owner";
import { EvaluationCancelled } from "@/lib/api/errors";
it.each(["prepare", "stream", "fetchChunk"] as const)("owns late native %s completion through departure", async stage => {
  const wait = deferred(); const entered = deferred();
  const controller = new AbortController(); const owner = new PgSourceOwner(controller.signal);
  const destroySync = vi.fn();
  const hold = async (where: string) => { if (stage === where) { entered.resolve(); await wait.promise; } };
  const result = { fetchChunk: vi.fn(async () => { await hold("fetchChunk"); return null; }) };
  const conn = { prepare: async () => { await hold("prepare"); return { destroySync }; },
    stream: async () => { await hold("stream"); return result; }, interrupt: vi.fn() };
  const guarded = owner.bind(conn as unknown as DuckDBConnection);
  const pending = (async () => {
    if (stage === "prepare") return guarded.prepare("SELECT 1");
    const stream = await guarded.stream("SELECT 1");
    if (stage === "fetchChunk") return stream.fetchChunk();
    return stream;
  })().then(() => null, e => e);
  try {
    await entered.promise; controller.abort();
    expect(conn.interrupt).toHaveBeenCalledOnce();
    wait.resolve();
    expect(await pending).toBeInstanceOf(EvaluationCancelled);
    if (stage === "prepare") expect(destroySync).toHaveBeenCalledOnce();
  } finally { wait.resolve(); await pending; owner.drainComplete(); }
});
it("classifies a source timeout raised while fetching a native chunk", async () => {
  const owner = new PgSourceOwner();
  const conn = { stream: async () => ({ fetchChunk: async () => { throw new Error("ERROR: canceling statement due to statement timeout"); } }) };
  const stream = await owner.bind(conn as unknown as DuckDBConnection).stream("SELECT 1");
  await expect(stream.fetchChunk()).rejects.toMatchObject({ code: "query_timeout", status: 408 });
});
