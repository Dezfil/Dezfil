import type { Database } from "better-sqlite3";
import { metadataDb } from "@/lib/metadata/db";
import { assistantAvailability } from "../config";
import { readAssistantKey, type KeyFacts, type KeyProvider } from "./store";

/**
 * Who pays for one caller's turn: their own key when they have one, else the
 * instance's when the server has one, else nobody. Nothing here reads another
 * account's key, so no answer can name one.
 */

export const ADD_YOUR_KEY = "Add your own API key to use the assistant.";
export const ADD_IT_AGAIN = "Your saved API key can no longer be read. Add it again.";

export type Payer =
  | ({ kind: "own"; provider: KeyProvider; key: string; save: string; facts: KeyFacts; instanceKey: boolean })
  | { kind: "instance"; provider: string; instanceKey: true; unreadable: boolean }
  | { kind: "none"; reason: string; instanceKey: false; unreadable: boolean };

export function resolvePayer(accountId: string, env: Record<string, string | undefined> = process.env, db: Database = metadataDb()): Payer {
  const instance = assistantAvailability(env);
  const own = readAssistantKey(accountId, db);
  if (own && own !== "unreadable") {
    const { key, save, ...facts } = own;
    return { kind: "own", provider: own.provider, key, save, facts, instanceKey: instance.enabled };
  }
  const unreadable = own === "unreadable";
  if (instance.enabled) return { kind: "instance", provider: instance.provider, instanceKey: true, unreadable };
  return { kind: "none", reason: unreadable ? ADD_IT_AGAIN : ADD_YOUR_KEY, instanceKey: false, unreadable };
}
