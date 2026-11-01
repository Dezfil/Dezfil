import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { getAccount } from "@/lib/metadata/accounts";
import { readGenerations } from "@/lib/metadata/auth-generations";
import { testAccountScope } from "@/lib/test-support/accounts";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { replenishStorageReserve, STORAGE_RELEASE_BYTES, STORAGE_RESERVE_BYTES, STORAGE_RESERVE_NAME } from "@/lib/system/storage-reserve";
import { readStorageState, STORAGE_FULL_BYTES } from "@/lib/system/storage-state";
import { POST as signOut } from "@/app/api/instance/sign-out/route";
import { POST as issueLink } from "@/app/api/users/[id]/sign-in-link/route";
import { PATCH as changeAccess } from "@/app/api/users/[id]/route";
import { authenticateSession, issueSession } from "./credentials";
import { inviteAccount } from "./admin";
import { SESSION_COOKIE } from "./http";

const disk = vi.hoisted(() => ({ full: false }));
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, statfsSync: (...args: Parameters<typeof actual.statfsSync>) => {
    const reading = actual.statfsSync(...args);
    return disk.full ? { ...reading, bavail: 0 } : reading;
  } };
});

const root = process.env.DEZFIL_DATA_DIR!;
let directory: string, adminSecret: string;
beforeEach(async () => {
  directory = mkdtempSync(path.join(root, "revocations-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory); closeMetadataDb();
  testAccountScope(undefined, "admin"); testAccountScope(undefined, "target");
  const db = metadataDb();
  db.exec("UPDATE accounts SET is_admin=1 WHERE id='admin'; UPDATE accounts SET password_hash='old hash',last_sign_in_at='time' WHERE id='target'");
  adminSecret = issueSession(getAccount("admin")!, db, Date.now()).secret;
  await replenishStorageReserve(() => ({ full: false, free: 4 * STORAGE_FULL_BYTES, total: 8 * STORAGE_FULL_BYTES, threshold: STORAGE_FULL_BYTES }));
});
afterEach(() => {
  disk.full = false; closeMetadataDb(); vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

it.each(["everyone", "reset", "new link", "deactivate"])("recovers %s at zero reported free bytes after a refused write", async action => {
  const db = metadataDb();
  let id = "target";
  if (action === "new link") id = inviteAccount(authenticateSession(adminSecret)!, { name: "Invited", email: "invited@example.test" }).account.id;
  const oldSession = issueSession(getAccount("target")!, db, Date.now()).secret;
  const before = readGenerations(db);
  const reserve = path.join(directory, STORAGE_RESERVE_NAME);
  let refused = 0;
  // The engine really refuses allocation until recovery releases reserve
  // blocks. The volume reading is zero; no filesystem is filled by the test.
  db.function("reserve_held", () => {
    if (statSync(reserve).size < STORAGE_RESERVE_BYTES) return 0;
    refused++;
    return 1;
  });
  const write = action === "everyone" ? "UPDATE ON auth_generations"
    : action === "deactivate" ? "UPDATE OF revoked_at ON auth_sessions"
      : "INSERT ON auth_links";
  db.exec(`CREATE TABLE full_write (bytes BLOB);
    CREATE TRIGGER full_revocation BEFORE ${write} WHEN reserve_held()
    BEGIN INSERT INTO full_write VALUES(zeroblob(1048576)); END;`);
  db.pragma(`max_page_count = ${db.pragma("page_count", { simple: true })}`);
  disk.full = true;
  expect(readStorageState()).toMatchObject({ full: true, free: 0 });
  const url = action === "everyone" ? "/api/instance/sign-out"
    : `/api/users/${id}${action === "deactivate" ? "" : "/sign-in-link"}`;
  const request = socketRequest(new Request(`http://instance.test${url}`, {
    method: action === "deactivate" ? "PATCH" : "POST",
    headers: { cookie: `${SESSION_COOKIE}=${adminSecret}`, origin: "http://instance.test", "content-type": "application/json" },
    body: JSON.stringify(action === "deactivate" ? { status: "deactivated" } : {}),
  }));
  const params = { params: Promise.resolve({ id }) };
  const response = await (action === "everyone" ? signOut(request) : action === "deactivate" ? changeAccess(request, params) : issueLink(request, params));
  expect(response.status).toBe(200);
  expect(refused).toBe(2);
  expect(statSync(reserve).size).toBe(STORAGE_RESERVE_BYTES - STORAGE_RELEASE_BYTES);
  expect(db.prepare("SELECT count(*) AS n FROM full_write").get()).toEqual({ n: 0 });
  if (action === "everyone") {
    expect(readGenerations(db)).toEqual({ ...before, sign_out_generation: before.sign_out_generation + 1 });
    expect(authenticateSession(adminSecret)).toBeNull();
    expect(authenticateSession(oldSession)).toBeNull();
  } else if (action === "deactivate") {
    expect(getAccount(id)?.status).toBe("deactivated");
    expect(authenticateSession(oldSession)).toBeNull();
  } else {
    expect((await response.json()).signInUrl).toContain("/accept#secret=");
    expect(db.prepare("SELECT count(*) AS n FROM auth_links WHERE account_id=? AND revoked_at IS NULL").get(id)).toEqual({ n: 1 });
    expect(db.prepare("SELECT password_hash FROM accounts WHERE id=?").get(id)).toEqual({ password_hash: null });
    if (action === "reset") expect(authenticateSession(oldSession)).toBeNull();
  }
});
