import { delegatedWorkKey } from "./account-deletion-work";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Database } from "better-sqlite3";
import { metadataDb } from "@/lib/metadata/db";
import { getAccount } from "@/lib/metadata/accounts";
import { sessionById, tokenById } from "@/lib/metadata/auth-credentials";
import { maintainCredentials } from "./credential-maintenance";
import { authenticateToken, expiredToken, requireCurrentActor, tokenExpired, type AuthContext } from "./credentials";

export const DELEGATION_LIFETIME_MS = 5 * 60 * 1000;
const PREFIX = "dz_delegation_";
const KEY = Symbol.for("dezfil.session-delegation-key");
function key(): Buffer {
  // Process state is shared by separately bundled server routes and the proxy.
  // Replacement discards the signing key; no delegation is a durable token.
  const state = process as typeof process & { [KEY]?: Buffer };
  return state[KEY] ??= randomBytes(32);
}
function sign(payload: string): Buffer { return createHmac("sha256", key()).update(payload).digest(); }

export function delegateCredential(context: AuthContext, db: Database = metadataDb(), now?: number): string {
  const account = requireCurrentActor(context, db, now);
  now ??= Date.now();
  const expiresAt = Math.min(now + DELEGATION_LIFETIME_MS, context.delegationExpiresAt ?? Infinity);
  const payload = Buffer.from(JSON.stringify({ accountId: account.id, kind: context.credential.kind, credentialId: context.credential.id, expiresAt })).toString("base64url");
  return PREFIX + payload + "." + sign(payload).toString("hex");
}

export function authenticateDelegation(secret: string, db: Database = metadataDb(), now?: number): AuthContext | null {
  if (!secret.startsWith(PREFIX)) return null;
  maintainCredentials(db, now);
  now ??= Date.now();
  const [payload, signature, extra] = secret.slice(PREFIX.length).split(".");
  if (extra !== undefined || !payload || !/^[a-f0-9]{64}$/.test(signature ?? "")) return null;
  if (!timingSafeEqual(sign(payload), Buffer.from(signature, "hex"))) return null;
  let value: { accountId?: unknown; kind?: unknown; credentialId?: unknown; expiresAt?: unknown };
  try { value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  if (!value || typeof value.accountId !== "string" || typeof value.credentialId !== "string" ||
      (value.kind !== "session" && value.kind !== "token") ||
      typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now) return null;
  const session = value.kind === "session" ? sessionById(value.credentialId, db) : null;
  const token = value.kind === "token" ? tokenById(value.credentialId, db) : null;
  const parent = session ?? token;
  const account = parent && getAccount(parent.account_id, db);
  if (!parent || !account || account.id !== value.accountId || account.status !== "active" || parent.revoked_at !== null ||
      (session !== null && session.expires_at <= now)) return null;
  // A delegation never outlives the token it was made from, and says why.
  if (token !== null && tokenExpired(token, now)) throw expiredToken();
  return { account, credential: { kind: value.kind, id: parent.id }, delegationExpiresAt: value.expiresAt, workKey: delegatedWorkKey(secret) };
}

export function authenticateBearer(secret: string, db: Database = metadataDb(), now?: number): AuthContext | null {
  return secret.startsWith(PREFIX) ? authenticateDelegation(secret, db, now) : authenticateToken(secret, db, now);
}
