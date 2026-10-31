import type { Database } from "better-sqlite3";
import { metadataDb } from "@/lib/metadata/db";
import { adoptDoorGeneration } from "@/lib/metadata/auth-generations";
import { externalSignIn } from "./external-sign-in/config";
import { AuthError } from "./errors";
export function outdatedToken(): AuthError {
  return new AuthError("token_outdated", "This token was made before everyone was signed out and no longer works. Create a new one.", 401);
}
/** Run before the first request so restored credentials cannot precede a configured floor. */
export function initializeAuthGenerations(db: Database = metadataDb()): boolean {
  return db.transaction(() => adoptDoorGeneration(externalSignIn().generationFloor, db)).immediate();
}
