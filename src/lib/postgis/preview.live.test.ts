import { testAccountScope, testAccountRequest } from "@/lib/test-support/accounts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { randomInt, randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { POST } from "@/app/api/connections/postgis/[id]/preview/route";
import { closeMetadataDb } from "@/lib/metadata/db";
import { getConnection, insertConnection } from "@/lib/metadata/connections";
import { resetSecretKeyCache } from "@/lib/secrets";
import { resolveCreateConnectionInput } from "./connection-input";
import { fixtureUrl, openSource, pgLiteral, watchAttachments, type SourceFixture } from "./live-source-fixture";

const url = process.env.DEZFIL_TEST_PG_URL;
async function until(predicate: () => Promise<boolean>, milliseconds: number, message: string) {
  const started = performance.now();
  while (performance.now() - started <= milliseconds) {
    if (await predicate()) {
      expect(performance.now() - started, message).toBeLessThanOrEqual(milliseconds);
      return;
    }
    await delay(100);
  }
  throw new Error(message);
}

describe.skipIf(!url)(url ? "live preview ownership" : "SKIP: DEZFIL_TEST_PG_URL is missing (held-preview PostGIS proof, docs/operate/runbook.md)", () => {
  let source: SourceFixture;
  let scratch: string;
  const schema = `dezfil_preview_${randomUUID().replace(/-/g, "")}`;
  beforeAll(async () => {
    scratch = mkdtempSync(path.join(process.cwd(), ".tmp-live-preview-"));
    vi.stubEnv("DEZFIL_DATA_DIR", scratch);
    vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", new URL(url!).hostname);
    closeMetadataDb(); resetSecretKeyCache();
    source = await openSource(url!);
    await source.exec(`CREATE SCHEMA ${schema}`);
    await source.exec(`CREATE VIEW ${schema}.normal AS SELECT 7::integer AS id`);
  }, 30_000);
  afterAll(async () => {
    try {
      if (source) {
        try { await source.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
        finally { await source.close(); }
      }
    } finally {
      closeMetadataDb(); resetSecretKeyCache(); vi.unstubAllEnvs();
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  it.each([true, false])("settles every backend of a held preview, aborted=%s", async (abort) => {
    const lock = randomInt(1, 2 ** 30);
    const suffix = abort ? "aborted" : "timeout";
    const id = randomUUID();
    insertConnection(testAccountScope(), { id, ...resolveCreateConnectionInput({ name: `Held source ${suffix}`, url: fixtureUrl(url!, "disable") }) });
    // The tag reports the timeout on the actual work backend before it waits.
    // Prefix matching still includes every sibling backend of this attachment.
    await source.exec(`CREATE FUNCTION ${schema}.hold_${suffix}() RETURNS TABLE(id integer) LANGUAGE plpgsql AS $fn$
      BEGIN
        PERFORM set_config('application_name', current_setting('application_name') || '_t' || current_setting('statement_timeout'), true);
        PERFORM pg_advisory_xact_lock(${lock}::bigint);
        RETURN QUERY SELECT 1::integer;
      END $fn$`);
    await source.exec(`CREATE VIEW ${schema}.${suffix} AS SELECT * FROM ${schema}.hold_${suffix}()`);
    const holder = await openSource(url!);
    const watch = watchAttachments();
    const controller = new AbortController();
    let pending: Promise<Response> | undefined;
    let response: Response | undefined;
    let measured = false;
    const makeRequest = (table: string, signal?: AbortSignal) => POST(testAccountRequest(new Request("http://localhost/api/connections/postgis/fixture/preview", {
      method: "POST", body: JSON.stringify({ schema, table }), signal,
    })), { params: Promise.resolve({ id }) });
    let identity: string | undefined;
    const owned = async () => {
      expect(identity, "The production attachment must have a unique source identity").toMatch(/^dezfil_preview_[a-f0-9]{32}$/);
      // No connection other than this attachment can carry this random prefix.
      // SQL prefix matching uses starts_with rather than LIKE, so underscores
      // in application names are literal and never wildcards.
      return source.query(`SELECT pid, application_name, state, wait_event_type FROM pg_stat_activity WHERE starts_with(application_name, ${pgLiteral(identity!)})`);
    };
    try {
      await holder.conn.run("BEGIN TRANSACTION");
      await holder.query(`SELECT pg_advisory_xact_lock(${lock}::bigint)::text AS held`);
      pending = makeRequest(suffix, controller.signal).then((reply) => { response = reply; return reply; });
      await until(async () => {
        identity = watch.attempts[0]?.identity;
        if (!identity) return false;
        return (await owned()).some((backend) => backend.wait_event_type === "Lock");
      }, 20_000, "Observer never saw the preview's source statement held on its lock");
      const waiting = (await owned()).filter((backend) => backend.wait_event_type === "Lock");
      expect(waiting.length).toBeGreaterThan(0);
      expect(waiting.map((backend) => backend.application_name)).toEqual(waiting.map(() => `${identity}_t30s`));
      const effectiveWorkTimeout = waiting.map((backend) => String(backend.application_name).slice(`${identity}_t`.length));
      expect(watch.attempts[0].timeout).toBe("30000");
      const started = performance.now();
      if (abort) controller.abort();
      let ownedBackendsRemaining: number | undefined;
      // A blocked libpq read runs to the ceiling; this bound does not prove
      // interrupt propagation while the source statement remains blocked.
      await until(async () => {
        if (!response) return false;
        ownedBackendsRemaining = (await owned()).length;
        return ownedBackendsRemaining === 0;
      }, 35_000,
        "The preview or an owned source backend survived 35 seconds while the hold remained");
      const elapsedMs = performance.now() - started;
      expect(elapsedMs).toBeLessThanOrEqual(35_000);
      const trustedReleased = watch.attempts[0].released;
      expect(trustedReleased, "The trusted connection must settle too").toBe(true);
      if (abort) {
        expect(response!.status).toBe(499); expect(await response!.text()).toBe("");
      } else {
        expect(response!.status).toBe(408);
        expect(await response!.json()).toEqual({ error: { code: "query_timeout", message: "The PostGIS source query took too long." } });
        expect(elapsedMs, "The source ceiling must not be an immediate refusal").toBeGreaterThan(25_000);
      }
      // the preview records no health, so the connection inserted for
      // this run stays unchecked however the preview ended.
      expect(getConnection(testAccountScope(), id)?.status).toBe("never_checked");
      expect(getConnection(testAccountScope(), id)?.lastCheckError).toBeNull();
      // The independent holder is still held; a normal sibling must work.
      const normal = await makeRequest("normal");
      expect(normal.status).toBe(200);
      expect((await normal.json()).rows).toEqual([{ id: 7 }]);
      measured = true;
      console.info(JSON.stringify({ abort, observedBackends: waiting.length, effectiveWorkTimeout, elapsedMs: Math.round(elapsedMs), ownedBackendsRemaining, trustedReleased, outcome: response!.status }));
    } finally {
      // Only after assertions (including failure): release the fixture's hold,
      // then terminate any residue bearing exactly this attachment's prefix.
      await holder.conn.run("ROLLBACK").catch(() => {});
      await holder.close();
      if (!measured && identity) {
        await source.query(`SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE starts_with(application_name, ${pgLiteral(identity)})`).catch(() => {});
      }
      if (pending) await until(async () => !!response, 15_000, "Preview did not settle after emergency fixture cleanup");
      watch.restore();
    }
  }, 100_000);
});
