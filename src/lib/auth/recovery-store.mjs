import Database from "better-sqlite3";
import { statSync } from "node:fs";
import path from "node:path";

// Kept in parity with the shipped migrations by a test, without importing the migrating opener.
export const RECOVERY_SCHEMA_VERSION = 55;
export const RECOVERY_BUSY_TIMEOUT_MS = 5000;
export const recoveryWaitRemaining = deadline => Math.max(0, Math.floor(deadline - performance.now()));

export class RecoveryError extends Error {}
const setup = () => new RecoveryError("No setup-complete store found. Start the instance with this data directory and complete setup first.");
const upgrade = () => new RecoveryError("Incompatible metadata store. Use the matching application version, or back up and upgrade the instance before admin recovery.");

export function recoveryFailure(error) {
  if (error?.code === "SQLITE_BUSY" || error?.code === "SQLITE_LOCKED") {
    return new RecoveryError("The metadata store stayed busy for five seconds. Retry admin recovery when the other writer has finished.");
  }
  return error instanceof RecoveryError ? error : upgrade();
}

export function recoveryOrigin(value) {
  try {
    if (typeof value !== "string" || !/^https?:\/\/[^/?#]+\/?$/i.test(value) || /[\s\\]/.test(value)) throw new Error();
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/") throw new Error();
    return url.origin;
  } catch {
    throw new RecoveryError("Supply an explicit reachable HTTP/HTTPS instance origin with no credentials, path, query or fragment.");
  }
}

/** Read-only checks repeated under the issuance transaction before any write. */
export function validateRecoveryStore(db) {
  try {
    if (db.pragma("user_version", { simple: true }) !== RECOVERY_SCHEMA_VERSION) throw upgrade();
    const columns = {
      accounts: "id,name,email,password_hash,is_admin,status,created_at,updated_at,last_sign_in_at,sql_name",
      original_account: "singleton,account_id",
      auth_links: "id,account_id,kind,secret_hash,created_at,expires_at,consumed_at,revoked_at",
      auth_sessions: "id,account_id,secret_hash,created_at,expires_at,last_used_at,revoked_at",
      auth_tokens: "id,account_id,name,secret_hash,created_at,last_used_at,revoked_at,expires_at",
    };
    for (const [table, fields] of Object.entries(columns)) db.prepare(`SELECT ${fields} FROM ${table} LIMIT 0`).all();
    if (!db.prepare(`SELECT 1 FROM original_account o JOIN accounts a ON a.id = o.account_id
      WHERE o.singleton = 1`).get()) throw setup();
  } catch (error) { throw recoveryFailure(error); }
}

export function openRecoveryStore(directory, deadline = performance.now() + RECOVERY_BUSY_TIMEOUT_MS) {
  let probe;
  let db;
  try {
    if (typeof directory !== "string" || !directory.trim()) throw setup();
    const file = path.join(directory, "metadata.sqlite");
    try {
      if (!statSync(file).isFile() || statSync(file).size === 0) throw setup();
    } catch { throw setup(); }
    // Even an empty existing SQLite file must never be initialized by recovery.
    probe = new Database(file, { readonly: true, fileMustExist: true, timeout: recoveryWaitRemaining(deadline) });
    probe.transaction(() => validateRecoveryStore(probe))();
    probe.close();
    db = new Database(file, { fileMustExist: true, timeout: recoveryWaitRemaining(deadline) });
    db.pragma("foreign_keys = ON");
    db.transaction(() => validateRecoveryStore(db))();
    db.pragma(`busy_timeout = ${recoveryWaitRemaining(deadline)}`);
    return db;
  } catch (error) {
    if (probe?.open) probe.close();
    if (db?.open) db.close();
    throw recoveryFailure(error);
  }
}

export function selectRecoveryAdmin(db, email) {
  if (email !== undefined) {
    const normalized = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(normalized)) throw new RecoveryError("Supply an exact admin email with --email.");
    const account = db.prepare("SELECT id, email FROM accounts WHERE email = ? AND is_admin = 1 AND status = 'active'").get(normalized);
    if (!account) throw new RecoveryError("That email does not identify an active admin. No credentials changed.");
    return account;
  }
  const accounts = db.prepare("SELECT id, email FROM accounts WHERE is_admin = 1 AND status = 'active' ORDER BY id").all();
  if (accounts.length === 0) throw new RecoveryError("No active admin is available. Complete setup or ask an active admin to restore access.");
  if (accounts.length !== 1) throw new RecoveryError("Several active admins exist. Select one with --email.");
  return accounts[0];
}
