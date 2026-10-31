import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import { metadataDb, closeMetadataDb, open } from "@/lib/metadata/db";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { makeStart, startCookieName } from "@/lib/auth/external-sign-in/start";
import { initializeExternalOwner } from "@/lib/auth/external-sign-in/owner";
import { SESSION_COOKIE } from "@/lib/auth/http";
import type { Ticket } from "@/lib/auth/external-sign-in/ticket";

export function externalFixture() {
  const directory = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "external-"));
  closeMetadataDb(); vi.stubEnv("DEZFIL_DATA_DIR", directory);
  const keys = generateKeyPairSync("ed25519");
  vi.stubEnv("DEZFIL_EXTERNAL_SIGN_IN_KEYS", keys.publicKey.export({ format: "jwk" }).x!);
  vi.stubEnv("DEZFIL_EXTERNAL_SIGN_IN_AUDIENCE", "instance"); vi.stubEnv("DEZFIL_EXTERNAL_SIGN_IN_URL", "https://door.example/sign-in");
  Reflect.deleteProperty(process, Symbol.for("dezfil.external-sign-in"));
  let db = metadataDb();
  initializeExternalOwner(db, { DEZFIL_EXTERNAL_SIGN_IN_OWNER_ID: "owner-id", DEZFIL_EXTERNAL_SIGN_IN_OWNER_EMAIL: "owner@example.test" });
  function ticket(patch: Partial<Ticket> = {}, now = Date.now()) {
    const start = makeStart(now);
    const claims: Ticket = { aud: "instance", sub: "owner-id", email: "owner@example.test", email_verified: true, name: "Owner",
      iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 300, jti: randomUUID(), start: start.value, door_generation: 0, ...patch };
    const data = [ { alg: "EdDSA" }, claims ].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
    return { encoded: `${data}.${sign(null, Buffer.from(data), keys.privateKey).toString("base64url")}`, cookie: `${startCookieName()}=${start.cookie}`, claims };
  }
  function request(value = ticket(), session?: string, body: unknown = { ticket: value.encoded }) {
    return socketRequest(new Request("https://instance.test/api/auth/external/arrive", { method: "POST", headers: {
      origin: "https://instance.test", "content-type": "application/json", cookie: `${value.cookie}${session ? `; ${SESSION_COOKIE}=${session}` : ""}`,
    }, body: JSON.stringify(body) }));
  }
  return { signingKey: keys.privateKey.export({ format: "jwk" }), get db() { return db; }, directory, ticket, request,
    restart() { closeMetadataDb(); if (db.open) db.close(); Reflect.deleteProperty(process, Symbol.for("dezfil.external-sign-in-start-key")); db = metadataDb(); },
    connection() { return open(path.join(directory, "metadata.sqlite")); },
    snapshot() { return ["accounts", "auth_sessions", "auth_tokens", "auth_links", "auth_ticket_ids", "auth_generations"].map(t => db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()); },
    close() { closeMetadataDb(); if (db.open) db.close(); vi.unstubAllEnvs(); vi.restoreAllMocks(); Reflect.deleteProperty(process, Symbol.for("dezfil.external-sign-in")); rmSync(directory, { recursive: true, force: true }); },
  };
}
