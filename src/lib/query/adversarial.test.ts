import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { executeQuery } from "./execute";

/**
 * Adversarial suite for the read-only guarantee (plan: highest-severity
 * risk). Every attempt must fail with the documented code AND leave the
 * data verifiably unchanged.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
  const src = path.join(dir, "assets.csv");
  await writeFile(src, "name,lon,lat\na,1,2\nb,3,4\n");
  await ingestFile(testAccountScope(), src, "assets.csv");
});

afterEach(async () => {
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

async function assertDataIntact() {
  const check = await executeQuery(testAccountScope(), "SELECT count(*) AS n FROM assets");
  expect(Number(check.preview[0].n)).toBe(2);
}

describe("read-only enforcement", () => {
  it("rejects one sample from every mutating statement category, data unchanged", async () => {
    const attempts = [
      // data change
      "INSERT INTO assets VALUES ('x', 9, 9)",
      "UPDATE assets SET name = 'p0wned'",
      "DELETE FROM assets",
      // schema change
      "CREATE TABLE exfil AS SELECT * FROM assets",
      "DROP VIEW assets",
      "ALTER TABLE assets ADD COLUMN c INT",
      // settings change
      "SET memory_limit = '100TB'",
      "SET allowed_directories = ['/']",
      "PRAGMA memory_limit = '100TB'",
      // extension load
      "INSTALL httpfs",
      "LOAD httpfs",
      // external attach
      "ATTACH '/tmp/evil.db' AS evil",
      // file write
      "COPY assets TO '/tmp/exfil.csv'",
      "EXPORT DATABASE '/tmp/exfil'",
      // obfuscation and stacking
      "/* comment */ DELETE FROM assets",
      "SELECT 1; DROP VIEW assets",
      "begin transaction",
    ];
    for (const sql of attempts) {
      await expect(executeQuery(testAccountScope(), sql), sql).rejects.toMatchObject({
        code: "sql_rejected",
      });
    }
    await assertDataIntact();
  });

  it("fences SELECT-shaped filesystem escapes to the artifact directory", async () => {
    const escapes = [
      "SELECT * FROM read_csv('/etc/hosts')",
      "SELECT * FROM read_parquet('/etc/hosts')",
      `SELECT * FROM read_text('${dir.replace(/'/g, "''")}/assets.csv')`,
      "SELECT * FROM glob('/etc/*')",
    ];
    for (const sql of escapes) {
      await expect(executeQuery(testAccountScope(), sql), sql).rejects.toMatchObject({
        code: "sql_error",
      });
    }
    // The metadata store sits outside the fence too.
    const metadata = path
      .join(process.env.DEZFIL_DATA_DIR!, "metadata.sqlite")
      .replace(/'/g, "''");
    await expect(
      executeQuery(testAccountScope(), `SELECT * FROM read_text('${metadata}')`),
    ).rejects.toMatchObject({ code: "sql_error" });
    await assertDataIntact();
  });

  it("keeps the artifact directory itself readable", async () => {
    const result = await executeQuery(testAccountScope(),
      "SELECT count(*) AS n FROM assets WHERE ST_X(geometry) > 0",
    );
    expect(Number(result.preview[0].n)).toBe(2);
  });
});
