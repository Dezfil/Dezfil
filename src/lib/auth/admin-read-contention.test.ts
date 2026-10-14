import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { open } from "@/lib/metadata/db";
import { getAccount } from "@/lib/metadata/accounts";
import { testAccountScope } from "@/lib/test-support/accounts";
import { resetSecretKeyCache } from "@/lib/secrets";
import { readInstanceSettings } from "@/lib/settings/read";
import { writeStoredSettings } from "@/lib/settings/store";
import { authenticateSession, issueSession, type AuthContext } from "./credentials";
import { previewAccountDeletion, confirmAccountDeletion, type DeletionPreview } from "./account-deletion-preview";

const scratch = process.env.DEZFIL_DATA_DIR!;
let directory: string, db: Database.Database, writer: Database.Database, context: AuthContext;
beforeEach(() => {
  directory = mkdtempSync(path.join(scratch, "admin-read-contention-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory); resetSecretKeyCache();
  const file = path.join(directory, "metadata.sqlite");
  db = open(file); writer = new Database(file);
  testAccountScope(db, "admin"); testAccountScope(db, "target");
  db.prepare("INSERT INTO recipes(id,name,created_at,updated_at,owner_id) VALUES ('owned','Owned','time','time','target')").run();
  db.exec("UPDATE accounts SET is_admin=1 WHERE id='admin'; UPDATE accounts SET status='deactivated' WHERE id='target'");
  context = authenticateSession(issueSession(getAccount("admin", db)!, db, Date.now()).secret, db)!;
  writeStoredSettings({ instanceName: "Stored name" }, db);
});
afterEach(() => {
  if (writer.inTransaction) writer.exec("ROLLBACK");
  writer.close(); db.close(); resetSecretKeyCache(); vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

it("reads instance settings without taking a write lock", () => {
  writer.exec("BEGIN IMMEDIATE");
  const began = performance.now();
  expect(readInstanceSettings(context, db).settings.instanceName.value).toBe("Stored name");
  expect(performance.now() - began).toBeLessThan(500);
  expect(writer.inTransaction).toBe(true);
});

it("previews deletion under a held writer and rechecks its inventory at acceptance", () => {
  writer.exec("BEGIN IMMEDIATE");
  writer.prepare("DELETE FROM recipes WHERE id = 'owned'").run();
  const began = performance.now();
  const preview = previewAccountDeletion(context, "target", db) as DeletionPreview;
  expect(preview.account.id).toBe("target");
  expect(preview.totals.workflows).toBe(1);
  expect(performance.now() - began).toBeLessThan(500);
  writer.exec("COMMIT");
  expect(() => confirmAccountDeletion(context, "target", { confirm: true, confirmation: preview.confirmation, email: preview.account.email }, db))
    .toThrow(expect.objectContaining({ code: "deletion_changed" }));
  expect(getAccount("target", db)?.status).toBe("deactivated");
  expect((previewAccountDeletion(context, "target", db) as DeletionPreview).totals.workflows).toBe(0);
});
