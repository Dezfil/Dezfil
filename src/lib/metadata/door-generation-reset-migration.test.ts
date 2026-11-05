import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { ASSISTANT_KEYS_MIGRATION } from "./migrations-assistant-keys";
import { EXTERNAL_SIGN_IN_MIGRATION } from "./migrations-external-sign-in";
import { DOOR_GENERATION_RESET_MIGRATION } from "./migrations-door-generation-reset";
import { IDENTITIES_MIGRATION, rebuildIdentities } from "./migrations-identities";
import { MIGRATIONS, open } from "./db";
import { allocateSqlNames, type SqlNameIdentity } from "./sql-names";
import { readDoorGenerationReset, lastDoorGenerationReset, recordDoorGenerationReset, readGenerations, setDoorGeneration } from "./auth-generations";

it("appends one reset-history migration after assistant keys and external sign-in, preserving the store", () => {
  const dir = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "reset-migration-"));
  const file = path.join(dir, "metadata.sqlite");
  const at = MIGRATIONS.indexOf(DOOR_GENERATION_RESET_MIGRATION);
  expect(at).toBe(MIGRATIONS.length - 1);
  expect(MIGRATIONS[at - 1]).toBe(ASSISTANT_KEYS_MIGRATION);
  expect(MIGRATIONS[at - 2]).toBe(EXTERNAL_SIGN_IN_MIGRATION);
  let db = new Database(file);
  try {
    db.pragma("foreign_keys = ON");
    db.function("allocate_sql_names", (input: unknown) => JSON.stringify(allocateSqlNames(JSON.parse(String(input)) as SqlNameIdentity[])));
    for (const [index, sql] of MIGRATIONS.slice(0, at).entries()) {
      if (sql === IDENTITIES_MIGRATION) rebuildIdentities(db, sql, index + 1); else db.exec(sql);
    }
    db.pragma(`user_version = ${at}`);
    db.exec("UPDATE auth_generations SET sign_out_generation=4, door_generation=9007199254740991");
    expect(() => db.prepare("SELECT * FROM auth_door_generation_resets").all()).toThrow(/no such table/);
    db.close(); db = open(file);
    expect(db.pragma("user_version", { simple: true })).toBe(at + 1);
    expect(readGenerations(db)).toEqual({ sign_out_generation: 4, door_generation: Number.MAX_SAFE_INTEGER });
    expect(lastDoorGenerationReset(db)).toBeNull();
    expect(readDoorGenerationReset(7, db)).toBeNull();
    const time = "2026-01-01T00:00:00.000Z";
    recordDoorGenerationReset(8, time, db);
    recordDoorGenerationReset(7, time, db);
    expect(() => recordDoorGenerationReset(7, time, db)).toThrow(/UNIQUE/);
    db.transaction(() => setDoorGeneration(7, db)).immediate();
    db.close(); db = open(file);
    expect(readDoorGenerationReset(8, db)).toEqual({ value: 8, applied_at: time });
    expect(lastDoorGenerationReset(db)).toEqual({ value: 7, applied_at: time });
    expect(readGenerations(db)).toEqual({ sign_out_generation: 4, door_generation: 7 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
      expect(() => setDoorGeneration(value, db)).toThrow(/non-negative safe whole number/);
      expect(readGenerations(db).door_generation).toBe(7);
    }
  } finally { if (db.open) db.close(); rmSync(dir, { recursive: true, force: true }); }
});
