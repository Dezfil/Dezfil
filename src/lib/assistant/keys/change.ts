import type { Database } from "better-sqlite3";
import { metadataDb } from "@/lib/metadata/db";
import { assistantBeginMark, endAccountAssistantWorkBefore } from "../retained-work";
import "../runs";
import "../pending";
import { removeAssistantKey, saveAssistantKey, type KeyFacts, type KeyProvider } from "./store";

/**
 * Changing a person's key stops paying at once: every turn of theirs begun
 * before the change ends, running and parked, and a later resolution of a parked
 * one says the key changed. A turn begun afterwards reads the new key. Adding a
 * first key replaces nothing, so what is running on the instance's key carries on.
 */

/** Interrupts synchronously, then lets the old work unwind on its own. */
export function stopTurnsOnOwnKey(accountId: string): void {
  void endAccountAssistantWorkBefore(accountId, assistantBeginMark(), "key_changed")
    .catch((error: unknown) => console.error("[assistant] ending turns after a key change failed:", error instanceof Error ? error.name : "unknown"));
}

export function setOwnKey(accountId: string, provider: KeyProvider, key: string, db: Database = metadataDb()): KeyFacts {
  const saved = saveAssistantKey(accountId, provider, key, db);
  if (saved.replaced) stopTurnsOnOwnKey(accountId);
  return saved.facts;
}

/** Harmless when there is none. */
export function removeOwnKey(accountId: string, db: Database = metadataDb()): boolean {
  const removed = removeAssistantKey(accountId, db);
  if (removed) stopTurnsOnOwnKey(accountId);
  return removed;
}
