import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Database } from "better-sqlite3";
import * as metadata from "@/lib/metadata/db";
import { initializeExternalOwner } from "./owner";
import { createFirstAccount } from "../accounts";
import { enter } from "../entry";
import { gateRequest } from "../gate";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { generateKeyPairSync } from "node:crypto";
const owner = { DEZFIL_EXTERNAL_SIGN_IN_OWNER_ID: "stable-owner", DEZFIL_EXTERNAL_SIGN_IN_OWNER_EMAIL: "Owner@example.test" };
let db: Database;
beforeEach(() => {
  db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  vi.stubEnv("DEZFIL_EXTERNAL_SIGN_IN_KEYS", generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x!);
  vi.stubEnv("DEZFIL_EXTERNAL_SIGN_IN_AUDIENCE", "instance"); vi.stubEnv("DEZFIL_EXTERNAL_SIGN_IN_URL", "https://door.example/sign-in");
});
afterEach(() => { db.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); Reflect.deleteProperty(process, Symbol.for("dezfil.external-sign-in")); });
it("creates exactly one invited admin bound to the configured identity, with no credential", () => {
  initializeExternalOwner(db, owner);
  const rows = db.prepare("SELECT * FROM accounts").all();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ external_identity: "stable-owner", email: "owner@example.test", is_admin: 1, status: "invited", password_hash: null, name: "" });
  for (const table of ["auth_sessions", "auth_tokens", "auth_links"]) expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
  initializeExternalOwner(db, {}); expect(db.prepare("SELECT * FROM accounts").all()).toEqual(rows);
});
it("refuses a missing owner on an empty store without changing it", () => {
  expect(() => initializeExternalOwner(db, {})).toThrow("DEZFIL_EXTERNAL_SIGN_IN_OWNER_ID");
  expect(() => initializeExternalOwner(db, { DEZFIL_EXTERNAL_SIGN_IN_OWNER_ID: "owner" })).toThrow("DEZFIL_EXTERNAL_SIGN_IN_OWNER_EMAIL");
  expect(db.prepare("SELECT * FROM accounts").all()).toEqual([]);
});
it("refuses the first-account service, operation and setup page before reading a body", async () => {
  await expect(createFirstAccount({ name: "Stranger", email: "stranger@example.test", password: "password" }, db)).rejects.toMatchObject({ code: "external_sign_in_only" });
  const request = socketRequest(new Request("http://instance.test/api/auth/setup", { method: "POST", body: "unread" }));
  const read = vi.spyOn(request, "body", "get");
  const response = await enter(request, "setup");
  expect(response.status).toBe(403); expect((await response.json()).error.code).toBe("external_sign_in_only");
  expect(read).not.toHaveBeenCalled();
  expect(gateRequest(socketRequest(new Request("http://instance.test/setup"))).status).toBe(403);
  expect(gateRequest(socketRequest(new Request("http://instance.test/sign-in"))).status).toBe(200);
  expect(db.prepare("SELECT * FROM accounts").all()).toEqual([]);
});
