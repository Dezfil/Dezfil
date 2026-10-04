import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { insertAccount } from "@/lib/metadata/accounts";
import { insertSession } from "@/lib/metadata/auth-credentials";
import { authenticateSession, secretHash } from "./credentials";
import { credentialPage, removeExpiredCredentials } from "@/lib/metadata/credential-maintenance";
import { register } from "@/instrumentation";

it("the real startup hook starts a bounded pass before any credential access", async () => {
  const directory = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "credential-boot-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory); vi.stubEnv("NEXT_RUNTIME", "nodejs");
  const db = metadata.open(path.join(directory, "metadata.sqlite"));
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  const now = Date.now();
  insertAccount({ id: "a", name: "A", email: "a@example.test", passwordHash: null, isAdmin: true, status: "active", now: new Date(now).toISOString() }, db);
  db.transaction(() => { for (let i = 0; i < 1201; i++) insertSession({ id: String(i).padStart(4, "0"), account_id: "a",
    secret_hash: String(i), created_at: 0, last_used_at: 0, expires_at: 0, revoked_at: null }, db); })();
  const count = () => db.prepare("SELECT count(*) AS n FROM auth_sessions").get();
  try {
    expect(count()).toEqual({ n: 1201 });
    await register(); expect(count()).toEqual({ n: 701 });
    authenticateSession("unknown", db); expect(count()).toEqual({ n: 201 });
    authenticateSession("unknown", db); expect(count()).toEqual({ n: 0 });
  } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});

it("a renewal committed by another connection between selection and deletion keeps its row", () => {
  const directory = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "credential-renewal-"));
  const file = path.join(directory, "metadata.sqlite"), db = metadata.open(file), other = metadata.open(file);
  const now = Date.now(), day = 86_400_000;
  try {
    insertAccount({ id: "a", name: "A", email: "a@example.test", passwordHash: null, isAdmin: true, status: "active", now: new Date(now).toISOString() }, db);
    insertSession({ id: "session", account_id: "a", secret_hash: secretHash("session"), created_at: now, last_used_at: now, expires_at: now + 1, revoked_at: null }, db);
    const page = credentialPage(db, "sessions", undefined);
    expect(authenticateSession("session", other, now)).not.toBeNull();
    expect(removeExpiredCredentials(db, "sessions", page, now + day + 1)).toBe(0);
    expect(authenticateSession("session", db, now + day + 1)).not.toBeNull();
  } finally { db.close(); other.close(); rmSync(directory, { recursive: true, force: true }); }
});
