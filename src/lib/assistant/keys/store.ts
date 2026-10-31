import type { Database } from "better-sqlite3";
import { metadataDb } from "@/lib/metadata/db";
import { decryptSecret, encryptSecret } from "@/lib/secrets";

/**
 * A person's own provider key. Encrypted at rest as connection passwords are,
 * and write-only outside the one accessor a turn binds to: everything else in
 * this module answers the facts, never the text.
 */

export const KEY_PROVIDERS = ["anthropic", "openai"] as const;
export type KeyProvider = (typeof KEY_PROVIDERS)[number];
export const KEY_MIN_LENGTH = 16;
export const KEY_MAX_LENGTH = 512;

export function isKeyProvider(value: unknown): value is KeyProvider {
  return value === "anthropic" || value === "openai";
}

/** What may be shown about a saved key. */
export interface KeyFacts { provider: KeyProvider; lastFour: string; savedAt: string }
/** A saved key's text with what identifies this save, for the turn it binds. */
export interface OwnKey extends KeyFacts { key: string; save: string }

interface Row { provider: KeyProvider; key_encrypted: string; last_four: string; saved_at: number }

const facts = (row: Row): KeyFacts => ({ provider: row.provider, lastFour: row.last_four, savedAt: new Date(row.saved_at).toISOString() });
const row = (accountId: string, db: Database) =>
  db.prepare("SELECT provider, key_encrypted, last_four, saved_at FROM assistant_keys WHERE account_id = ?").get(accountId) as Row | undefined;

/** The trimmed key, or null for anything a key may not be. The refusal is the
 * caller's, and it never repeats what was sent. */
export function cleanKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim();
  if (key.length < KEY_MIN_LENGTH || key.length > KEY_MAX_LENGTH) return null;
  return /^[^\s\p{Cc}]+$/u.test(key) ? key : null;
}

/** Writes one row, replacing any before it; answers whether there was one. */
export function saveAssistantKey(accountId: string, provider: KeyProvider, key: string,
  db: Database = metadataDb(), now = Date.now()): { replaced: boolean; facts: KeyFacts } {
  const saved: Row = { provider, key_encrypted: encryptSecret(key), last_four: key.slice(-4), saved_at: now };
  const replaced = db.transaction(() => {
    const before = row(accountId, db) !== undefined;
    db.prepare(`INSERT INTO assistant_keys (account_id, provider, key_encrypted, last_four, saved_at)
      VALUES (@accountId, @provider, @key_encrypted, @last_four, @saved_at)
      ON CONFLICT (account_id) DO UPDATE SET provider = excluded.provider, key_encrypted = excluded.key_encrypted,
        last_four = excluded.last_four, saved_at = excluded.saved_at`).run({ accountId, ...saved });
    return before;
  }).immediate();
  return { replaced, facts: facts(saved) };
}

/** Whether the row went. Removing nothing is not a failure. */
export function removeAssistantKey(accountId: string, db: Database = metadataDb()): boolean {
  return db.prepare("DELETE FROM assistant_keys WHERE account_id = ?").run(accountId).changes > 0;
}

/** The facts of a saved key, readable or not, without touching its text. */
export function assistantKeyFacts(accountId: string, db: Database = metadataDb()): KeyFacts | null {
  const saved = row(accountId, db);
  return saved ? facts(saved) : null;
}

/** The one read of the text. A row that no longer opens (another encryption
 * key, damage) reads as no key: nothing can spend it and the person adds it
 * again. */
export function readAssistantKey(accountId: string, db: Database = metadataDb()): OwnKey | "unreadable" | null {
  const saved = row(accountId, db);
  if (!saved) return null;
  try { return { ...facts(saved), key: decryptSecret(saved.key_encrypted), save: saved.key_encrypted }; }
  catch { return "unreadable"; }
}

/** Whether the save a turn bound to is still the account's key. */
export function isCurrentSave(accountId: string, save: string, db: Database = metadataDb()): boolean {
  return row(accountId, db)?.key_encrypted === save;
}
