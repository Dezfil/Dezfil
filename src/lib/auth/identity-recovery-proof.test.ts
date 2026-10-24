import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { MIGRATIONS, open } from "@/lib/metadata/db";
import { markOriginalAccount } from "@/lib/metadata/accounts";
import { allocateSqlNames, type SqlNameIdentity } from "@/lib/metadata/sql-names";
import { redeemSignInLink } from "./links";

let directory: string, db: Database.Database;
const origin = "http://127.0.0.1:3391", email = "remaining@example.test";
beforeEach(() => {
  // Shell-significant path characters also exercise util-linux's command quoting.
  directory = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "identity recovery ' $input-"));
  const file = path.join(directory, "metadata.sqlite");
  db = new Database(file);
  db.function("allocate_sql_names", (input: unknown) => JSON.stringify(allocateSqlNames(JSON.parse(String(input)) as SqlNameIdentity[])));
  for (const sql of MIGRATIONS.slice(0, 46)) db.exec(sql);
  db.pragma("user_version = 46");
  // Written as that version's store held it: today's account reads name
  // columns a store this old does not have yet.
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO accounts (id, name, email, password_hash, is_admin, status, created_at, updated_at, sql_name)
    VALUES ('remaining', 'Remaining admin', ?, 'old hash', 1, 'active', ?, ?, 'remaining_admin')`).run(email, now, now);
  markOriginalAccount("remaining", db);
  db.close(); db = open(file);
});
afterEach(() => { if (db.open) db.close(); rmSync(directory, { recursive: true, force: true }); });

function command() {
  const helper = pathToFileURL(path.resolve("scripts/account-identity-recovery.mjs")).href;
  // The proof's caller has a pipe for stdin, even if this test is run in a terminal.
  return spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { recoveryCommandLink } from ${JSON.stringify(helper)};
    assert.notEqual(process.stdin.isTTY, true);
    try {
      process.stdout.write(recoveryCommandLink(...process.argv.slice(1)));
    } catch (error) {
      process.stderr.write(error.message);
      process.exitCode = 1;
    }
  `, process.cwd(), directory, origin, email], {
    encoding: "utf8", input: "", timeout: 15_000,
    env: { ...process.env, DEZFIL_DATA_DIR: directory },
  });
}

it("issues through a real terminal from a non-interactive caller and redeems on the migrated store", async () => {
  const result = command();
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const secret = new URLSearchParams(new URL(result.stdout).hash.slice(1)).get("secret")!;
  expect((await redeemSignInLink(secret, "recovered paper cranes at dawn", db)).account.email).toBe(email);
});

it("keeps the recovery schema seed red at its named link assertion without credential changes", () => {
  db.pragma("user_version = 46");
  const before = db.prepare("SELECT * FROM accounts").all();
  const result = command();
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("matching recovery command issues exactly one link");
  expect(result.stdout).toBe("");
  expect(db.prepare("SELECT * FROM accounts").all()).toEqual(before);
  expect(db.prepare("SELECT * FROM auth_links").all()).toEqual([]);
});
