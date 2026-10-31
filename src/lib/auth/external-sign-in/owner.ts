import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import { metadataDb } from "@/lib/metadata/db";
import { accountCount, insertAccount, markOriginalAccount, normalizeEmail } from "@/lib/metadata/accounts";
import { adoptLegacyPreferences } from "../adoption";
import { externalSignIn, firstOwnerConfiguration } from "./config";

/** Startup only. No network request chooses the first external identity. */
export function initializeExternalOwner(db: Database = metadataDb(), env: Readonly<Record<string, string | undefined>> = process.env, now = Date.now()): void {
  if (!externalSignIn().enabled) return;
  db.transaction(() => {
    if (accountCount(db) > 0) return;
    const owner = firstOwnerConfiguration(env);
    if (!owner.id || owner.id.length > 256) throw new Error("DEZFIL_EXTERNAL_SIGN_IN_OWNER_ID is required on an empty instance and must be at most 256 characters.");
    const email = normalizeEmail(owner.email);
    if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 320) throw new Error("DEZFIL_EXTERNAL_SIGN_IN_OWNER_EMAIL must be an email address on an empty instance.");
    if (owner.name.length > 80) throw new Error("DEZFIL_EXTERNAL_SIGN_IN_OWNER_NAME must be at most 80 characters.");
    // An absent name stays empty until the first ticket supplies it. This
    // distinguishes an absent name from a configured name equal to the email.
    const account = insertAccount({ id: randomUUID(), name: owner.name, email, passwordHash: null,
      status: "invited", isAdmin: true, now: new Date(now).toISOString() }, db);
    db.prepare("UPDATE accounts SET external_identity = ? WHERE id = ?").run(owner.id, account.id);
    markOriginalAccount(account.id, db);
    adoptLegacyPreferences(account.id, db);
  }).immediate();
}
