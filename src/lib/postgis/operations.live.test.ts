import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DuckDBConnection } from "@duckdb/node-api";
import { pbkdf2, randomInt, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { currentTrustedOperation } from "@/lib/trusted-operation";
import { limits } from "@/lib/limits";
import { engineStateForTests } from "@/lib/duckdb";
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
import { sourceCallLimit, workerPoolSize } from "./source-slots";

const scratchRoot = process.env.DEZFIL_DATA_DIR ?? "/tmp";
const url = process.env.DEZFIL_TEST_PG_URL;
async function until(predicate: () => Promise<boolean>, milliseconds: number, message: string) {
  const started = performance.now();
  while (performance.now() - started <= milliseconds) { if (await predicate()) return; await delay(100); }
  throw new Error(message);
}
/** How Postgres shows a millisecond setting: in the largest unit that divides it. */
const shownDuration = (ms: number) => ms % 60_000 === 0 ? `${ms / 60_000}min` : ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
const kinds = ["create", "edit", "test", "catalogue", "preview", "import", "refresh"] as const;
describe.skipIf(!url)(url ? "live source operation ownership" : "SKIP: DEZFIL_TEST_PG_URL is missing (all-operation source ownership, docs/self-host/backup-and-restore.md)", () => {
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
  it("imports a source whose transfer outlasts the preview ceiling at the default limits", async () => {
    const scope = testAccountScope(), id = randomUUID();
    insertConnection(scope, { id, ...resolveCreateConnectionInput({ name: "Slow transfer", url: fixtureUrl(url!, "disable") }) });
    // The one row takes 31 s to produce: past the 30 s preview ceiling, well
    // inside the default processing limit of an import.
    await source.exec(`CREATE FUNCTION ${schema}.slow_id() RETURNS integer LANGUAGE sql VOLATILE AS $fn$ SELECT pg_sleep(31); SELECT 7 $fn$`);
    await source.exec(`CREATE VIEW ${schema}.slow AS SELECT ${schema}.slow_id() AS id`);
    const watch = watchAttachments();
    try {
      const table = await importPostgis(scope, { connectionId: id, schema, table: "slow" });
      expect(table.rowCount).toBe(1);
      expect(Number(watch.attempts[0].timeout)).toBeGreaterThan(31_000);
    } finally { watch.restore(); }
  }, 120_000);
  // The source ceiling is the time left when the source is attached, so a
  // statement that starts after the attachment has spent time could outlast
  // the expiry by that time. More than the 35 s allowance is spent first here,
  // so only a cancellation at the expiry settles the blocked read in time.
  it.each(["import", "refresh"] as const)("%s settles a read that blocks after the attachment spent time, within the allowance after expiry", async kind => {
    const scope = testAccountScope(), id = randomUUID(), lock = randomInt(1, 2 ** 30), tag = randomUUID().replace(/-/g, "");
    insertConnection(scope, { id, ...resolveCreateConnectionInput({ name: `Late block ${kind}`, url: fixtureUrl(url!, "disable") }) });
    await source.exec(`CREATE FUNCTION ${schema}.held_${tag}() RETURNS integer LANGUAGE plpgsql AS $fn$ BEGIN PERFORM pg_advisory_xact_lock(${lock}::bigint); RETURN 7; END $fn$`);
    await source.exec(`CREATE VIEW ${schema}.late_${tag} AS SELECT ${schema}.held_${tag}() AS id`);
    await source.exec(`CREATE FUNCTION ${schema}.slow_${tag}() RETURNS text LANGUAGE sql VOLATILE AS $fn$ SELECT pg_sleep(40); SELECT version() $fn$`);
    const recipe = { connectionId: id, schema, table: `late_${tag}` };
    const previous = kind === "refresh" ? await importPostgis(scope, recipe) : null;
    const before = listTables().map(t => t.file).sort();
    const holder = await openSource(url!); const watch = watchAttachments();
    let operation: ReturnType<typeof currentTrustedOperation>;
    const nativeRead = DuckDBConnection.prototype.runAndReadAll;
    // The first statement on the attachment takes 40 s of the 45 s limit; the
    // import read after it then blocks on a lock the fixture holds.
    const slowRead = vi.spyOn(DuckDBConnection.prototype, "runAndReadAll").mockImplementation(function (this: DuckDBConnection, sql, ...args) {
      if (sql.includes("SELECT version() AS v")) operation = currentTrustedOperation();
      return nativeRead.call(this, sql.includes("postgres_query") && sql.includes("SELECT version() AS v") ? sql.replace("SELECT version() AS v", `SELECT ${schema}.slow_${tag}() AS v`) : sql, ...args);
    });
    const processingLimit = vi.spyOn(limits, "dataProcessingTimeoutMs", "get").mockReturnValue(45_000);
    let pending: Promise<unknown> | undefined, finished = false, outcome: unknown, identity: string | undefined, measured = false;
    const owned = () => source.query(`SELECT pid, wait_event_type FROM pg_stat_activity WHERE starts_with(application_name, ${pgLiteral(identity!)})`);
    try {
      await holder.conn.run("BEGIN TRANSACTION"); await holder.query(`SELECT pg_advisory_xact_lock(${lock}::bigint)::text AS held`);
      const work = kind === "import" ? importPostgis(scope, recipe) : refreshTable(scope, previous!.name);
      pending = work.then(value => { outcome = value; finished = true; }, error => { outcome = error; finished = true; });
      await until(async () => { identity = watch.attempts[0]?.identity; return !!identity && (await owned()).some(b => b.wait_event_type === "Lock"); }, 60_000, "The import read never reached its held state");
      const ceiling = Number(watch.attempts[0].timeout);
      expect(ceiling).toBeGreaterThan(40_000);
      await until(async () => finished, 60_000, "The operation never answered");
      expect(outcome).toMatchObject({ code: "data_processing_timeout", status: 408 });
      const decidedAt = operation!.decidedAt!;
      expect(decidedAt).not.toBeNull();
      // The held read started about 40 s after the attachment, so its own
      // ceiling alone would end it about 40 s after the expiry.
      await until(async () => (await owned()).length === 0, Math.max(0, decidedAt + 35_000 - performance.now()), "Source backends survived the settlement allowance after expiry");
      const settledMs = performance.now() - decidedAt;
      expect(settledMs).toBeLessThanOrEqual(35_000);
      expect(watch.attempts[0].released).toBe(true);
      expect(listTables().map(t => t.file).sort()).toEqual(before);
      measured = true;
      console.info(JSON.stringify({ operation: kind, lateBlock: true, ceilingMs: ceiling, settledAfterExpiryMs: Math.round(settledMs), backendsRemaining: 0, outcome: outcome instanceof ApiError ? outcome.code : "other" }));
    } finally {
      await holder.conn.run("ROLLBACK").catch(() => {}); await holder.close();
      if (!measured && identity) await source.query(`SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE starts_with(application_name, ${pgLiteral(identity)})`).catch(() => {});
      if (pending) await until(async () => finished, 60_000, "Source work did not settle after emergency fixture cleanup");
      slowRead.mockRestore(); watch.restore(); processingLimit.mockRestore();
    }
  }, 200_000);
  // A source statement blocked on the server holds one of the runtime's
  // workers until the server answers, and the cancellation that ends it needs
  // a worker too, as does the rest of the server. With more late-blocked
  // imports and refreshes than the pool has workers, every one must still be
  // cancelled at its expiry and settle within the allowance, while cheap work
  // on the pool keeps running.
  it("cancels more late-blocked imports and refreshes than the worker pool has workers, and other pool work keeps running", async () => {
    const scope = testAccountScope(), id = randomUUID(), lock = randomInt(1, 2 ** 30), tag = randomUUID().replace(/-/g, "");
    const count = workerPoolSize() + 1, refreshes = Math.floor(count / 2), limit = sourceCallLimit();
    // Each attachment's first statement lasts until one moment longer than the
    // allowance after the start, so a read that blocks after it would outlast
    // the allowance on its own ceiling; one that starts after that moment
    // returns at once. The limit leaves a few seconds to reach the read.
    const sleepS = 38, processingMs = 42_000;
    insertConnection(scope, { id, ...resolveCreateConnectionInput({ name: "Saturated pool", url: fixtureUrl(url!, "disable") }) });
    await source.exec(`CREATE FUNCTION ${schema}.held_${tag}() RETURNS integer LANGUAGE plpgsql AS $fn$ BEGIN PERFORM pg_advisory_xact_lock(${lock}::bigint); RETURN 7; END $fn$`);
    await source.exec(`CREATE VIEW ${schema}.late_${tag} AS SELECT ${schema}.held_${tag}() AS id`);
    await source.exec(`CREATE TABLE ${schema}.until_${tag} (at timestamptz)`);
    await source.exec(`CREATE FUNCTION ${schema}.slow_${tag}() RETURNS text LANGUAGE plpgsql VOLATILE AS $fn$ BEGIN PERFORM pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM ((SELECT at FROM ${schema}.until_${tag}) - clock_timestamp())))); RETURN version(); END $fn$`);
    const recipe = { connectionId: id, schema, table: `late_${tag}` };
    const previous: string[] = [];
    for (let index = 0; index < refreshes; index++) previous.push((await importPostgis(scope, recipe)).name);
    const before = listTables().map(t => t.file).sort();
    const probeFile = path.join(scratch, `probe-${tag}.txt`); await writeFile(probeFile, "probe");
    const holder = await openSource(url!); const watch = watchAttachments();
    const nativeRead = DuckDBConnection.prototype.runAndReadAll;
    const slowRead = vi.spyOn(DuckDBConnection.prototype, "runAndReadAll").mockImplementation(function (this: DuckDBConnection, sql, ...args) {
      return nativeRead.call(this, sql.includes("postgres_query") && sql.includes("SELECT version() AS v") ? sql.replace("SELECT version() AS v", `SELECT ${schema}.slow_${tag}() AS v`) : sql, ...args);
    });
    const processingLimit = vi.spyOn(limits, "dataProcessingTimeoutMs", "get").mockReturnValue(processingMs);
    const outcomes: unknown[] = [];
    let pending: Promise<unknown> | undefined, measured = false;
    const identities = () => watch.attempts.flatMap(attempt => attempt.identity ? [attempt.identity] : []);
    const backends = async () => (await source.query("SELECT application_name, state FROM pg_stat_activity WHERE starts_with(application_name, 'dezfil_source_')"))
      .filter(backend => identities().some(identity => String(backend.application_name).startsWith(identity)));
    try {
      await holder.conn.run("BEGIN TRANSACTION"); await holder.query(`SELECT pg_advisory_xact_lock(${lock}::bigint)::text AS held`);
      await source.exec(`INSERT INTO ${schema}.until_${tag} SELECT clock_timestamp() + make_interval(secs => ${sleepS})`);
      // Every operation is admitted here, so none expires before this.
      const expiry = performance.now() + processingMs;
      const work = Array.from({ length: count }, (_, index) => index < refreshes ? refreshTable(scope, previous[index]) : importPostgis(scope, recipe));
      pending = Promise.all(work.map(operation => operation.then(value => value, error => error).then(outcome => { outcomes.push(outcome); })));
      // After the first statements, while the reads that follow them block, before the expiry.
      await delay(Math.max(0, expiry - processingMs + (sleepS + 2) * 1000 - performance.now()));
      expect(outcomes).toHaveLength(0);
      const probeStarted = performance.now();
      const probeMs = await Promise.race([
        Promise.all([
          new Promise<void>((resolve, reject) => pbkdf2("password", "salt", 1, 32, "sha256", error => error ? reject(error) : resolve())),
          readFile(probeFile),
        ]).then(() => performance.now() - probeStarted),
        delay(3_000).then(() => null),
      ]);
      expect.soft(probeMs, "A cheap task on the worker pool waited behind the blocked source calls").not.toBeNull();
      expect.soft(outcomes, "An operation answered before the probe finished").toHaveLength(0);
      // As many source calls are out on the server as the bound allows, and no more.
      const active = (await backends()).filter(backend => backend.state === "active").length;
      expect.soft(active).toBe(limit);
      await until(async () => outcomes.length === count, processingMs + 60_000, "The operations never answered");
      for (const outcome of outcomes) expect(outcome).toMatchObject({ code: "data_processing_timeout", status: 408 });
      // Every attachment's backends and every engine lease, the cancellations'
      // own included, are gone within the allowance after the expiry.
      await until(async () => (await backends()).length === 0 && engineStateForTests().leases === 0, Math.max(0, expiry + 35_000 - performance.now()), "Source backends or engine leases survived the settlement allowance after expiry");
      const settledMs = performance.now() - expiry;
      expect(settledMs).toBeLessThanOrEqual(35_000);
      expect(watch.attempts.length).toBeGreaterThan(0);
      for (const attempt of watch.attempts) expect(attempt.released).toBe(true);
      expect(listTables().map(t => t.file).sort()).toEqual(before);
      measured = true;
      console.info(JSON.stringify({ workerPool: workerPoolSize(), sourceCallLimit: limit, operations: count, refreshes, probeMs: probeMs === null ? null : Math.round(probeMs), activeAtProbe: active, settledAfterExpiryMs: Math.round(settledMs), ceilingsMs: watch.attempts.map(attempt => Number(attempt.timeout)) }));
    } finally {
      await holder.conn.run("ROLLBACK").catch(() => {}); await holder.close();
      if (!measured) for (const identity of identities()) await source.query(`SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE starts_with(application_name, ${pgLiteral(identity)})`).catch(() => {});
      if (pending) await until(async () => outcomes.length === count, 120_000, "Source work did not answer after emergency fixture cleanup");
      slowRead.mockRestore(); watch.restore(); processingLimit.mockRestore();
    }
  }, 300_000);
  async function exercise(kind: typeof kinds[number], depart: boolean) {
    const scope = testAccountScope(), id = randomUUID(), lock = randomInt(1, 2 ** 30);
    // Both sets share one data folder, and a connection name is unique per owner.
    const values = resolveCreateConnectionInput({ name: `Held ${kind} ${depart ? "through departure" : "to expiry"}`, url: fixtureUrl(url!, "disable") });
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
      // A preview, and other work that cancels on departure with more than 30 s
      // left, keep the 30 s source ceiling; otherwise it is what is left of the limit.
      const ceiling = Number(watch.attempts[0].timeout);
      if (kind === "preview" || (depart && !processing)) expect(ceiling).toBe(30_000);
      else { expect(ceiling).toBeGreaterThan(0); expect(ceiling).toBeLessThanOrEqual(depart ? 60_000 : 10_000); }
      const waiting = (await owned()).filter(b => b.wait_event_type === "Lock"); expect(waiting.length).toBeGreaterThan(0);
      // The source reports the ceiling it enforces on the held statement.
      expect(waiting.map(b => b.application_name)).toEqual(waiting.map(() => `${identity}_t${shownDuration(ceiling)}`));
      const started = performance.now();
      if (depart) controller.abort();
      if (depart && processing) {
        await delay(250); expect(finished).toBe(false); expect((await owned()).some(b => b.wait_event_type === "Lock")).toBe(true);
        // Accepted processing survives departure and commits after the independent hold is released.
        await holder.conn.run("ROLLBACK");
      }
      await until(async () => finished && (await owned()).length === 0, depart ? 35_000 : 45_000, "Operation or source backends survived the settlement allowance");
      const elapsedMs = performance.now() - started;
      // A departure that cancels the work cancels its held statement on the
      // server too, rather than leaving it to the 30 s source ceiling.
      if (depart && !processing) expect(elapsedMs).toBeLessThan(15_000);
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
