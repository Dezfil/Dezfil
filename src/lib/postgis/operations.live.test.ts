import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DuckDBConnection } from "@duckdb/node-api";
import { randomInt, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { currentTrustedOperation } from "@/lib/trusted-operation";
import { limits } from "@/lib/limits";
import { ApiError, EvaluationCancelled } from "@/lib/api/errors";
import { closeMetadataDb } from "@/lib/metadata/db";
import { insertConnection, getConnection } from "@/lib/metadata/connections";
import { listTables } from "@/lib/metadata/tables";
import { resetSecretKeyCache } from "@/lib/secrets";
import { testAccountScope } from "@/lib/test-support/accounts";
import { refreshTable } from "@/lib/ingest/refresh";
import { createConnection, editConnection, testSavedConnection, browseConnection } from "./connection-service";
import { importPostgis } from "./import";
import { previewPostgis } from "./preview";
import { resolveCreateConnectionInput } from "./connection-input";
import { fixtureUrl, openSource, pgLiteral, watchAttachments, type SourceFixture } from "./live-source-fixture";

const scratchRoot = process.env.DEZFIL_DATA_DIR ?? "/tmp";
const url = process.env.DEZFIL_TEST_PG_URL;
async function until(predicate: () => Promise<boolean>, milliseconds: number, message: string) {
  const started = performance.now();
  while (performance.now() - started <= milliseconds) { if (await predicate()) return; await delay(100); }
  throw new Error(message);
}
const kinds = ["create", "edit", "test", "catalogue", "preview", "import", "refresh"] as const;
describe.skipIf(!url)(url ? "live source operation ownership" : "SKIP: DEZFIL_TEST_PG_URL is missing (all-operation source ownership, docs/runbook.md)", () => {
  let source: SourceFixture, scratch: string;
  const schema = `dezfil_source_${randomUUID().replace(/-/g, "")}`;
  beforeAll(async () => {
    scratch = await mkdtemp(path.join(scratchRoot, "source-live-")); vi.stubEnv("DEZFIL_DATA_DIR", scratch); vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", new URL(url!).hostname);
    closeMetadataDb(); resetSecretKeyCache(); source = await openSource(url!);
    await source.exec(`CREATE SCHEMA ${schema}`); await source.exec(`CREATE TABLE ${schema}.normal (id integer)`); await source.exec(`INSERT INTO ${schema}.normal VALUES (7)`);
  }, 30_000);
  afterAll(async () => {
    try { if (source) { try { await source.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await source.close(); } } }
    finally { closeMetadataDb(); resetSecretKeyCache(); vi.unstubAllEnvs(); if (scratch) await rm(scratch, { recursive: true, force: true }); }
  }, 30_000);
  it.each(kinds)("%s settles blocked source work after expiry and retains committed artifacts", async kind => { await exercise(kind, false); }, 100_000);
  it.each(kinds)("%s applies its departure policy while the source is held", async kind => { await exercise(kind, true); }, 100_000);
  async function exercise(kind: typeof kinds[number], depart: boolean) {
    const scope = testAccountScope(), id = randomUUID(), lock = randomInt(1, 2 ** 30);
    const values = resolveCreateConnectionInput({ name: `Held ${kind}`, url: fixtureUrl(url!, "disable") });
    insertConnection(scope, { id, ...values, ...(kind === "edit" ? { password: "not-the-fixture-password" } : {}) });
    const recipe = { connectionId: id, schema, table: "normal" };
    const previous = kind === "refresh" ? await importPostgis(scope, recipe) : null;
    const before = listTables().map(t => t.file).sort();
    const fn = `hold_${randomUUID().replace(/-/g, "")}`;
    await source.exec(`CREATE FUNCTION ${schema}.${fn}() RETURNS text LANGUAGE plpgsql AS $fn$
      BEGIN
        PERFORM set_config('application_name', current_setting('application_name') || '_t' || current_setting('statement_timeout'), true);
        PERFORM pg_advisory_xact_lock(${lock}::bigint);
        RETURN version();
      END $fn$`);
    const holder = await openSource(url!); const watch = watchAttachments(); const controller = new AbortController();
    // Hold the real source health statement on every operation, including
    // catalogue and connection tests which have no caller-selected relation.
    let operation: ReturnType<typeof currentTrustedOperation>;
    const nativeRead = DuckDBConnection.prototype.runAndReadAll;
    const heldRead = vi.spyOn(DuckDBConnection.prototype, "runAndReadAll").mockImplementation(function (this: DuckDBConnection, sql, ...args) {
      if (sql.includes("SELECT version() AS v")) operation = currentTrustedOperation();
      return nativeRead.call(this, sql.includes("postgres_query") && sql.includes("SELECT version() AS v") ? sql.replace("SELECT version() AS v", `SELECT ${schema}.${fn}() AS v`) : sql, ...args);
    });
    const queryLimit = vi.spyOn(limits, "queryTimeoutMs", "get").mockReturnValue(depart ? 60_000 : 10_000);
    const processingLimit = vi.spyOn(limits, "dataProcessingTimeoutMs", "get").mockReturnValue(depart ? 60_000 : 10_000);
    let pending: Promise<unknown> | undefined, finished = false, outcome: unknown, identity: string | undefined, measured = false;
    const processing = kind === "import" || kind === "refresh";
    const owned = () => source.query(`SELECT pid, application_name, wait_event_type FROM pg_stat_activity WHERE starts_with(application_name, ${pgLiteral(identity!)})`);
    try {
      await holder.conn.run("BEGIN TRANSACTION"); await holder.query(`SELECT pg_advisory_xact_lock(${lock}::bigint)::text AS held`);
      const work = kind === "create" ? createConnection(scope, values, controller.signal) : kind === "edit" ? editConnection(scope, id, { password: values.password }, controller.signal)
        : kind === "test" ? testSavedConnection(scope, id, controller.signal) : kind === "catalogue" ? browseConnection(scope, id, controller.signal)
          : kind === "preview" ? previewPostgis(scope, id, { schema, table: "normal" }, undefined, controller.signal)
            : kind === "import" ? importPostgis(scope, recipe, undefined, controller.signal) : refreshTable(scope, previous!.name, { signal: controller.signal });
      pending = work.then(value => { outcome = value; finished = true; }, error => { outcome = error; finished = true; });
      await until(async () => { identity = watch.attempts[0]?.identity; return !!identity && (await owned()).some(b => b.wait_event_type === "Lock"); }, 8_000, "Source statement never reached its held state");
      expect(identity).toMatch(/^dezfil_(source|preview)_[a-f0-9]{32}$/);
      expect(watch.attempts[0].timeout).toBe("30000");
      const waiting = (await owned()).filter(b => b.wait_event_type === "Lock"); expect(waiting.length).toBeGreaterThan(0);
      expect(waiting.map(b => b.application_name)).toEqual(waiting.map(() => `${identity}_t30s`));
      const started = performance.now();
      if (depart) controller.abort();
      if (depart && processing) {
        await delay(250); expect(finished).toBe(false); expect((await owned()).some(b => b.wait_event_type === "Lock")).toBe(true);
        // Accepted processing survives departure and commits after the independent hold is released.
        await holder.conn.run("ROLLBACK");
      }
      await until(async () => finished && (await owned()).length === 0, depart ? 35_000 : 45_000, "Operation or source backends survived the settlement allowance");
      const elapsedMs = performance.now() - started;
      expect(watch.attempts[0].released).toBe(true);
      if (depart && processing) { expect(outcome).not.toBeInstanceOf(Error); expect(listTables().some(t => t.sourceParams?.connectionId === id)).toBe(true); }
      else {
        expect(operation?.decidedAt).not.toBeNull();
        expect(performance.now() - operation!.decidedAt!).toBeLessThanOrEqual(35_000);
        if (depart) expect(outcome).toBeInstanceOf(EvaluationCancelled);
        else expect(outcome).toMatchObject({ code: processing ? "data_processing_timeout" : "query_timeout", status: 408 });
        expect(listTables().map(t => t.file).sort()).toEqual(before);
        expect(getConnection(scope, id)?.name).toBe(values.name);
      }
      measured = true;
      console.info(JSON.stringify({ operation: kind, depart, elapsedMs: Math.round(elapsedMs), backendsRemaining: 0, trustedReleased: true, outcome: outcome instanceof ApiError ? outcome.code : outcome instanceof EvaluationCancelled ? "cancelled" : "completed" }));
    } finally {
      await holder.conn.run("ROLLBACK").catch(() => {}); await holder.close();
      if (!measured && identity) await source.query(`SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE starts_with(application_name, ${pgLiteral(identity)})`).catch(() => {});
      if (pending) await until(async () => finished, 15_000, "Source work did not settle after emergency fixture cleanup");
      heldRead.mockRestore(); watch.restore(); queryLimit.mockRestore(); processingLimit.mockRestore();
    }
  }
});
