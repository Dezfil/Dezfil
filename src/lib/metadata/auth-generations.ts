import type { Database } from "better-sqlite3";
export interface CredentialGenerations { sign_out_generation: number; door_generation: number }
export function readGenerations(db: Database): CredentialGenerations {
  return db.prepare("SELECT sign_out_generation,door_generation FROM auth_generations WHERE singleton=1").get() as CredentialGenerations;
}
/** One predicate for every credential reader, including delegated parents. */
export function credentialIsCurrent(row: CredentialGenerations, db: Database): boolean {
  const current = readGenerations(db);
  return row.sign_out_generation >= current.sign_out_generation && row.door_generation >= current.door_generation;
}
/** Call inside the credential-creation transaction. A lower floor never lowers stored state. */
export function adoptDoorGeneration(floor: number, db: Database): boolean {
  if (!Number.isSafeInteger(floor) || floor < 0) throw new Error("Door generation must be a non-negative safe whole number.");
  return db.prepare("UPDATE auth_generations SET door_generation=? WHERE singleton=1 AND door_generation < ?").run(floor, floor).changes > 0;
}
/** Call inside an immediate transaction after authorizing the admin. */
export function raiseSignOutGeneration(db: Database): CredentialGenerations {
  if (readGenerations(db).sign_out_generation >= Number.MAX_SAFE_INTEGER) throw new Error("Sign-out generation exhausted.");
  db.prepare("UPDATE auth_generations SET sign_out_generation=sign_out_generation+1 WHERE singleton=1").run();
  return readGenerations(db);
}

export interface DoorGenerationReset { value: number; applied_at: string }
export function readDoorGenerationReset(value: number, db: Database): DoorGenerationReset | null {
  return db.prepare("SELECT value,applied_at FROM auth_door_generation_resets WHERE value=?").get(value) as DoorGenerationReset | undefined ?? null;
}
export function lastDoorGenerationReset(db: Database): DoorGenerationReset | null {
  return db.prepare("SELECT value,applied_at FROM auth_door_generation_resets ORDER BY applied_at DESC, rowid DESC LIMIT 1").get() as DoorGenerationReset | undefined ?? null;
}
/** Call in the reset transaction, together with the two generation writes. */
export function recordDoorGenerationReset(value: number, appliedAt: string, db: Database): void {
  db.prepare("INSERT INTO auth_door_generation_resets(value,applied_at) VALUES (?,?)").run(value, appliedAt);
}
/** Recovery alone may lower the door generation. Call inside its immediate transaction. */
export function setDoorGeneration(value: number, db: Database): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Door generation must be a non-negative safe whole number.");
  db.prepare("UPDATE auth_generations SET door_generation=? WHERE singleton=1").run(value);
}
