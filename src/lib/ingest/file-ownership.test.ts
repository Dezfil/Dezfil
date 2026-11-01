import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { registerAccountFile, ownedFileRecords } from "./file-ownership";
import { acceptAccountDeletion, finishAccountDeletion } from "@/lib/auth/account-deletion";
import { authenticateSession, issueSession } from "@/lib/auth/credentials";
import { getAccount } from "@/lib/metadata/accounts";
import { cleanIngestScratch } from "./scratch";

const injection = vi.hoisted(() => ({ bytes: null as string | null }));
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
    if (injection.bytes !== null && (/ownership-.*\.tmp$/.test(String(args[0])) || String(args[0]).includes("/file-owners/"))) {
      actual.writeFileSync(args[0], injection.bytes);
      throw Object.assign(new Error("destination full"), { code: "ENOSPC" });
    }
    return actual.writeFileSync(...args);
  } };
});
const root = process.env.DEZFIL_DATA_DIR!;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(root, "ownership-")); vi.stubEnv("DEZFIL_DATA_DIR", dir);
  closeMetadataDb(); testAccountScope(undefined, "unrelated"); testAccountScope(undefined, "admin");
  mkdirSync(path.join(dir, "tables"), { recursive: true });
  mkdirSync(path.join(dir, "tmp"), { recursive: true });
  registerAccountFile("unrelated", "tables/control.parquet");
  writeFileSync(path.join(dir, "tables/control.parquet"), "control");
});
afterEach(() => { injection.bytes = null; closeMetadataDb(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

it.each(["", '{"accountId":'])("cleans an ownership write interrupted after %j and permits unrelated erasure after restart", async bytes => {
  injection.bytes = bytes;
  expect(() => registerAccountFile("failed", "tables/failed.parquet")).toThrow("destination full");
  injection.bytes = null;
  expect(readdirSync(path.join(dir, "tmp"))).toEqual([]);
  expect(ownedFileRecords().map(record => record.accountId)).toEqual(["unrelated"]);
  closeMetadataDb();
  await cleanIngestScratch();
  const db = metadataDb();
  expect(ownedFileRecords().map(record => record.accountId)).toEqual(["unrelated"]);
  db.exec("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'; UPDATE accounts SET status = 'deactivated', last_sign_in_at = 'time' WHERE id = 'unrelated'");
  const actor = authenticateSession(issueSession(getAccount("admin")!, db, Date.now()).secret)!;
  const deletion = acceptAccountDeletion(actor, "unrelated", () => {});
  expect(await finishAccountDeletion(actor, deletion.id)).toMatchObject({ state: "completed" });
  expect(ownedFileRecords()).toEqual([]);
  expect(readdirSync(path.join(dir, "tables"))).toEqual([]);
});

it("keeps a complete published record on repeated registration or conflicting ownership", () => {
  const names = readdirSync(path.join(dir, "file-owners"));
  const previous = readFileSync(path.join(dir, "file-owners", names[0]));
  registerAccountFile("unrelated", "tables/control.parquet");
  expect(() => registerAccountFile("intruder", "tables/control.parquet")).toThrow("Conflicting");
  expect(readFileSync(path.join(dir, "file-owners", names[0]))).toEqual(previous);
});
