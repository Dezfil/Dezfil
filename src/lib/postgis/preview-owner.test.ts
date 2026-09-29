import { testAccountScope } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";

const fixture = vi.hoisted(() => ({ acquire: vi.fn(), resolve: vi.fn() }));
vi.mock("@/lib/duckdb", () => ({ withConnection: async (work: (conn: DuckDBConnection) => Promise<unknown>) => {
  const conn = await fixture.acquire();
  try { return await work(conn); } finally { conn.disconnectSync(); }
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
  return { stages, sql, entered, release, run: vi.fn(execute), runAndReadAll: vi.fn(execute), interrupt: vi.fn(), disconnectSync: vi.fn() };
}
function preview(controller = new AbortController()) {
  return POST(new Request("http://localhost/api/connections/postgis/c1/preview", {
    method: "POST", body: JSON.stringify({ schema: "public", table: "attrs" }), signal: controller.signal,
  }), { params: Promise.resolve({ id: target.id }) });
}
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(process.cwd(), ".tmp-preview-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
  closeMetadataDb(); resetSecretKeyCache(); insertConnection(testAccountScope(), target);
  fixture.acquire.mockReset().mockImplementation(async () => connection());
  fixture.resolve.mockReset().mockResolvedValue(["192.0.2.1"]);
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
    expect(getConnection(target.id)?.status).toBe("never_checked");
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
      conn.release.resolve();
      const response = await pending;
      expect(response.status).toBe(499); expect(await response.text()).toBe("");
      expect(conn.stages.slice(conn.stages.indexOf(stage) + 1)).toEqual(stage === "load" ? [] : ["detach"]);
      expect(conn.disconnectSync).toHaveBeenCalledOnce();
      expect(getConnection(target.id)?.status).toBe("never_checked");
    },
  );
  it("discards a result when departure occurs during teardown", async () => {
    const conn = connection("detach"); fixture.acquire.mockResolvedValue(conn);
    const controller = new AbortController(); const pending = preview(controller);
    await conn.entered.promise; controller.abort(); conn.release.resolve();
    expect((await pending).status).toBe(499);
    expect(conn.disconnectSync).toHaveBeenCalledOnce();
    expect(getConnection(target.id)?.status).toBe("never_checked");
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
  });
  it.each(["attach", "version", "extension", "columns", "rows"] as Stage[])(
    "classifies the source ceiling during %s as 408 without recording failure", async (stage) => {
      const conn = connection(undefined, stage); fixture.acquire.mockResolvedValue(conn);
      const response = await preview();
      expect(response.status).toBe(408);
      expect(await response.json()).toEqual({ error: { code: "query_timeout", message: "The PostGIS source query took too long." } });
      expect(getConnection(target.id)?.status).toBe("never_checked");
      expect(conn.disconnectSync).toHaveBeenCalledOnce();
    },
  );
  it("lets caller departure win over a simultaneous source timeout", async () => {
    const conn = connection("rows", "rows"); fixture.acquire.mockResolvedValue(conn);
    const controller = new AbortController(); const pending = preview(controller);
    await conn.entered.promise; controller.abort(); conn.release.resolve();
    expect((await pending).status).toBe(499);
    expect(getConnection(target.id)?.status).toBe("never_checked");
  });
  it("carries a unique preview identity and ceiling in source startup options only for previews", async () => {
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
    for (const attach of attachments.slice(2)) { expect(attach).not.toContain("statement_timeout"); expect(attach).not.toContain("dezfil_preview_"); }
  });
});
