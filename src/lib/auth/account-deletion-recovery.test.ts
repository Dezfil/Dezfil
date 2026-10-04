import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { metadataDb, closeMetadataDb } from "@/lib/metadata/db";
import { getAccount, setupComplete } from "@/lib/metadata/accounts";
import { testAccountScope } from "@/lib/test-support/accounts";
import { shareProject } from "@/lib/test-support/sharing";
import { transferMap } from "@/lib/metadata/transfers";
import { createMap } from "@/lib/map-service";
import { authenticateSession, issueSession } from "./credentials";
import { acceptAccountDeletion, finishAccountDeletion } from "./account-deletion";
import { recoveryProcess } from "./recovery-process-fixture";
const root = process.env.DEZFIL_DATA_DIR!;
let directory: string, mapId: string;
beforeEach(async () => {
  directory = mkdtempSync(path.join(root, "deleted-original-")); process.env.DEZFIL_DATA_DIR = directory; closeMetadataDb();
  const original = testAccountScope(undefined, "original"); testAccountScope(undefined, "remaining");
  const db = metadataDb(); shareProject("original", "shared", [["remaining", "editor"]]);
  const map = createMap(original, "Retained home", "shared"); mapId = map.id;
  transferMap(original, mapId, "remaining", db, { expectedRevision: map.editRevision });
  db.exec("UPDATE accounts SET is_admin=1 WHERE id='remaining'; UPDATE accounts SET status='deactivated',last_sign_in_at='time' WHERE id='original'");
  const actor = authenticateSession(issueSession(getAccount("remaining")!, db, Date.now()).secret)!;
  const accepted = acceptAccountDeletion(actor, "original", () => {});
  expect(await finishAccountDeletion(actor, accepted.id)).toMatchObject({ state: "completed" });
});
afterEach(() => { closeMetadataDb(); process.env.DEZFIL_DATA_DIR = root; rmSync(directory, { recursive: true, force: true }); });
it("keeps adoption and transferred SQL homes after deleting the original profile and reopening", () => {
  closeMetadataDb(); const db = metadataDb();
  expect(setupComplete(db), "original-profile deletion must not reopen setup").toBe(true);
  expect(getAccount("original", db)).toBeNull();
  expect(db.prepare("SELECT account_id FROM original_account").get()).toEqual({ account_id: "original" });
  expect(db.prepare("SELECT owner_id,home_account_id FROM maps WHERE id=?").get(mapId)).toEqual({ owner_id: "remaining", home_account_id: "original" });
  expect(db.prepare("SELECT sql_name,status FROM accounts WHERE id='original'").get()).toEqual({ sql_name: "original", status: "deleted" });
});
it("issues and redeems remaining-admin recovery in separate processes after original-profile deletion", async () => {
  closeMetadataDb(); const now = Date.now();
  const issuer = recoveryProcess(directory);
  try {
    await issuer.ready; issuer.start({ kind: "issue", now });
    const issued = await issuer.result;
    expect(issued.ok, "remaining-admin recovery after original-profile deletion").toBe(true);
    const secret = new URLSearchParams(new URL(issued.url!).hash.slice(1)).get("secret");
    const redeem = recoveryProcess(directory);
    try {
      await redeem.ready; redeem.start({ kind: "redeem", secret, password: "paper cranes after midnight", now: now + 1 });
      expect(await redeem.result).toMatchObject({ ok: true, account: { id: "remaining", isAdmin: true } });
      expect(metadataDb().prepare("SELECT owner_id,home_account_id FROM maps WHERE id=?").get(mapId)).toEqual({ owner_id: "remaining", home_account_id: "original" });
    } finally { redeem.stop(); await redeem.result.catch(() => {}); }
  } finally { issuer.stop(); await issuer.result.catch(() => {}); }
});
