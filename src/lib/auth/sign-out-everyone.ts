import type { Database } from "better-sqlite3";
import { metadataDb } from "@/lib/metadata/db";
import { readGenerations, raiseSignOutGeneration } from "@/lib/metadata/auth-generations";
import { assistantBeginMark, endAssistantWorkBefore } from "@/lib/assistant/retained-work";
import { requireAdmin } from "./admin";
import type { AuthContext } from "./credentials";

/** Abort before returning. Do not wait on the caller's own assistant request:
 * it may be executing the sign-out tool and waiting for this response. */
export function interruptOlderAssistantWork(mark: number): void {
  void endAssistantWorkBefore(mark).catch(error => console.error("[auth] assistant interruption failed:", error));
}
export function signEveryoneOut(context: AuthContext, db: Database = metadataDb(), now = Date.now()) {
  const mark = assistantBeginMark();
  const generations = db.transaction(() => {
    requireAdmin(context, db, now); raiseSignOutGeneration(db); return readGenerations(db);
  }).immediate();
  interruptOlderAssistantWork(mark);
  return { signOutGeneration: generations.sign_out_generation, doorGeneration: generations.door_generation };
}
