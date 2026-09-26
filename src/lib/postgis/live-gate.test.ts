import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

describe("missing live fixture evidence", () => {
  it.each(["missing", "empty"])("reports named skips and no passing stand-in when the PostGIS URL is %s", (state) => {
    const dir = mkdtempSync(path.join(process.cwd(), ".tmp-pg-gate-"));
    const report = path.join(dir, "result.json");
    const env = { ...process.env };
    delete env.DEZFIL_TEST_PG_URL;
    delete env.DEZFIL_TEST_PG_TLS_URL;
    if (state === "empty") { env.DEZFIL_TEST_PG_URL = ""; env.DEZFIL_TEST_PG_TLS_URL = ""; }
    try {
      const child = spawnSync(process.execPath, [
        path.resolve("node_modules/vitest/vitest.mjs"), "run", "src/lib/postgis/postgis.live.test.ts", "src/lib/postgis/tls.live.test.ts", "src/lib/postgis/preview.live.test.ts",
        "--reporter=json", `--outputFile=${report}`,
      ], { env, encoding: "utf8", timeout: 15_000, stdio: "pipe" });
      expect(child.status, child.stderr).toBe(0);
      const raw = readFileSync(report, "utf8");
      const result = JSON.parse(raw) as {
        testResults: { assertionResults: { status: string; fullName: string }[] }[];
      };
      const tests = result.testResults.flatMap((suite) => suite.assertionResults);
      expect(tests.length).toBeGreaterThan(20);
      expect(tests.map((test) => test.status)).toEqual(tests.map(() => "skipped"));
      for (const test of tests) expect(test.fullName).toMatch(/SKIP: DEZFIL_TEST_PG(?:_TLS)?_URL is missing/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 20_000);
});
