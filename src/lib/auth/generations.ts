import { assistantBeginMark } from "@/lib/assistant/retained-work";
import { interruptOlderAssistantWork } from "./sign-out-everyone";
import type { Database } from "better-sqlite3";
import { metadataDb } from "@/lib/metadata/db";
import { adoptDoorGeneration, readDoorGenerationReset, recordDoorGenerationReset, setDoorGeneration, raiseSignOutGeneration } from "@/lib/metadata/auth-generations";
import { externalSignIn, doorGenerationReset } from "./external-sign-in/config";
import { AuthError } from "./errors";
export function outdatedToken(): AuthError {
  return new AuthError("token_outdated", "This token was made before everyone was signed out and no longer works. Create a new one.", 401);
}
/** Apply recovery before the floor and before the first request. Eligibility and
 * both generation writes share the lock with the durable application record. */
export function initializeAuthGenerations(db: Database = metadataDb()): boolean {
  const mark = assistantBeginMark();
  const value = doorGenerationReset(), floor = externalSignIn().generationFloor;
  const result = db.transaction(() => {
    const previous = value === null ? null : readDoorGenerationReset(value, db);
    const applied = value !== null && previous === null;
    if (applied) {
      setDoorGeneration(value, db);
      raiseSignOutGeneration(db);
      recordDoorGenerationReset(value, new Date().toISOString(), db);
    }
    const raised = adoptDoorGeneration(floor, db);
    return { previous, applied, raised };
  }).immediate();
  if (result.applied) console.info(`[auth] Door generation reset to ${value}; every session and token ended.`);
  else if (result.previous) console.info(`[auth] Door generation reset ${value} was already applied at ${result.previous.applied_at}; choose a new value to reset again.`);
  if (result.applied || result.raised) interruptOlderAssistantWork(mark);
  return result.applied || result.raised;
}
