import type { Database } from "better-sqlite3";
import { metadataDb } from "@/lib/metadata/db";
import { stopAccountAssistantWork } from "../retained-work";
import "../runs";
import "../pending";
import { removeAssistantKey, saveAssistantKey, type KeyFacts, type KeyProvider } from "./store";

/**
 * Changing a person's key stops paying at once: every turn of theirs begun
 * before the change ends, running and parked, and a later resolution of a parked
 * one says the key changed. A turn begun afterwards reads the new key. Adding a
 * first key replaces nothing, so what is running on the instance's key carries on.
 */

export function setOwnKey(accountId: string, provider: KeyProvider, key: string, db: Database = metadataDb()): KeyFacts {
  const saved = saveAssistantKey(accountId, provider, key, db);
  if (saved.replaced) stopAccountAssistantWork(accountId, "key_changed");
  return saved.facts;
}

/** Harmless when there is none. */
export function removeOwnKey(accountId: string, db: Database = metadataDb()): boolean {
  const removed = removeAssistantKey(accountId, db);
  if (removed) stopAccountAssistantWork(accountId, "key_changed");
  return removed;
}
