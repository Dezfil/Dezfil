import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { resolveCreateConnectionInput } from "./connection-input";
import { withPg } from "./access";
import { fixtureUrl, openSource, watchAttachments, type SourceFixture } from "./live-source-fixture";

for (const [variable, encrypted] of [["DEZFIL_TEST_PG_URL", false], ["DEZFIL_TEST_PG_TLS_URL", true]] as const) {
  const url = process.env[variable];
  describe.skipIf(!url)(url ? `live TLS ${encrypted? "capable": "disabled"}` : `SKIP: ${variable} is missing (disposable ${encrypted ? "TLS-capable" : "TLS-disabled"} PostGIS, docs/operate/runbook.md)`, () => {
    let source: SourceFixture;
    let scratch: string;
    let watch: ReturnType<typeof watchAttachments>;
    beforeAll(async () => {
      scratch = mkdtempSync(path.join(process.cwd(), ".tmp-live-tls-"));
      vi.stubEnv("DEZFIL_DATA_DIR", scratch);
      vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", new URL(url!).hostname);
      source = await openSource(url!);
      const [settings] = await source.query("SELECT current_setting('ssl') AS enabled");
      expect(settings.enabled, `${variable} must have TLS ${encrypted ? "on" : "off"}`).toBe(encrypted ? "on" : "off");
    }, 30_000);
    afterAll(async () => {
      try { await source?.close(); }
      finally { vi.unstubAllEnvs(); if (scratch) rmSync(scratch, { recursive: true, force: true }); }
    });
    beforeEach(() => { watch = watchAttachments(); });
    afterEach(() => watch.restore());

    it.each(["require", "prefer", "disable", "allow"])("pairs outgoing %s with the work backend's negotiated TLS", async (mode) => {
      const target = resolveCreateConnectionInput({ name: "TLS fixture", url: fixtureUrl(url!, mode) });
      const operation = withPg(target, async (conn, passthrough) => {
        const read = await conn.runAndReadAll(`SELECT * FROM ${passthrough("SELECT pg_backend_pid() AS pid")}`);
        const pid = Number(read.getRowObjects()[0]?.pid);
        expect(Number.isInteger(pid)).toBe(true);
        const states = await source.query(`SELECT ssl FROM pg_stat_ssl WHERE pid = ${pid}`);
        expect(states).toHaveLength(1);
        expect(states[0].ssl).toBe(encrypted);
        return states[0].ssl;
      });
      if (mode === "require" && !encrypted) await expect(operation).rejects.toMatchObject({ code: "connection_failed" });
      else await expect(operation).resolves.toBe(encrypted);
      expect(watch.attempts).toHaveLength(1);
      expect(watch.attempts[0].mode).toBe(mode === "require" ? "require" : "prefer");
      expect(watch.attempts[0].released).toBe(true);
      console.info(JSON.stringify({ mode, outgoing: watch.attempts[0].mode, outcome: mode === "require" && !encrypted ? "refused by TLS-disabled source" : { encrypted } }));
    }, 30_000);
    it.each(["verify-ca", "verify-full", "unknown"])("refuses %s before contacting the source", async (mode) => {
      const operation = async () => withPg(resolveCreateConnectionInput({ name: "Refused fixture", url: fixtureUrl(url!, mode) }), async () => {});
      await expect(operation()).rejects.toThrow("This URL uses an unsupported or conflicting SSL mode;");
      expect(watch.attempts).toHaveLength(0);
    });
  });
}
