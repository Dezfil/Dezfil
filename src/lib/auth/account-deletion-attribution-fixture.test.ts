import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { metadataDb, closeMetadataDb } from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { clearFixtureAttribution } from "../../../scripts/deletion-attribution-fixture.mjs";
const root = process.env.DEZFIL_DATA_DIR!;
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(root, "actor-fixture-")); process.env.DEZFIL_DATA_DIR = directory; closeMetadataDb();
  testAccountScope(undefined, "owner"); const db = metadataDb();
  db.exec(`INSERT INTO maps(id,name,created_at,updated_at,owner_id,last_changed_at,last_changed_by)
    VALUES ('map','Map','time','time','owner','changed','owner');
    INSERT INTO recipes(id,name,created_at,updated_at,owner_id,last_changed_at,last_changed_by)
    VALUES ('recipe','Workflow','time','time','owner','changed','owner');
    INSERT INTO cascade_runs(id,recipe_id,kind,started_at,initiator_id) VALUES ('run','recipe','all','started','owner');`);
});
afterEach(() => { closeMetadataDb(); process.env.DEZFIL_DATA_DIR = root; rmSync(directory, { recursive: true, force: true }); });
function rows() { const db = metadataDb(); return ['maps', 'recipes', 'cascade_runs'].map(table => db.prepare(`SELECT * FROM ${table}`).get() as Record<string, unknown>); }
it("makes legacy attribution without changing any other fact or leaving the trigger weakened", () => {
  const db = metadataDb(), before = rows(), triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all();
  clearFixtureAttribution(db, { mapId: 'map', recipeId: 'recipe', runId: 'run' });
  expect(rows()).toEqual(before.map((row, index) => ({ ...row, [index === 2 ? 'initiator_id' : 'last_changed_by']: null })));
  expect(db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all()).toEqual(triggers);
  db.prepare("UPDATE cascade_runs SET initiator_id = 'owner' WHERE id = 'run'").run();
  expect(() => db.prepare("UPDATE cascade_runs SET initiator_id = NULL WHERE id = 'run'").run()).toThrow('A run initiator cannot change');
});
it("rolls back all fixture changes and the trigger if its named run is absent", () => {
  const before = rows(), db = metadataDb(), trigger = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'cascade_runs_initiator_fixed'").get();
  expect(() => clearFixtureAttribution(db, { mapId: 'map', recipeId: 'recipe', runId: 'missing' })).toThrow();
  expect(rows()).toEqual(before); expect(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'cascade_runs_initiator_fixed'").get()).toEqual(trigger);
});
