import type { Database } from "better-sqlite3";
import { beforeEach, afterEach, expect, it } from "vitest";
import { open } from "@/lib/metadata/db";
import { accountCount } from "@/lib/metadata/accounts";
import { accountViewPrefs } from "@/lib/metadata/account-preferences";
import { getSetting, setSetting } from "@/lib/metadata/settings";
import { createFirstAccount } from "./accounts";

let db: Database;
const input = { name: "Chosen name", email: "first@example.test", password: "field notebooks at dawn" };
const prefs = { maps: { view: "list", sort: "name" }, projects: { sort: "largest" } };
beforeEach(() => {
  db = open(":memory:");
  setSetting("display_name", "Legacy name", db);
  setSetting("view_prefs", JSON.stringify(prefs), db);
  setSetting("instance_name", "Field atlas", db);
  const now = "2026-01-01T00:00:00.000Z";
  db.exec(`INSERT INTO projects VALUES ('project', 'Survey', 'Keep this', '${now}', '${now}');
    INSERT INTO maps (id, name, publish_token, published_at, created_at, updated_at, project_id)
      VALUES ('map', 'Legacy map', 'legacy-publication', '${now}', '${now}', '${now}', 'project');
    INSERT INTO data_tables (id, name, format, file, row_count, created_at)
      VALUES ('table', 'survey', 'geoparquet', 'tables/survey.parquet', 4, '${now}');
    INSERT INTO project_datasets VALUES ('project', 'table', '${now}');
    INSERT INTO recipes (id, name, origin, created_at, updated_at, project_id)
      VALUES ('recipe', 'Legacy workflow', 'workflow', '${now}', '${now}', 'project');
    INSERT INTO pg_connections (id, name, host, port, database, username, password_encrypted, created_at)
      VALUES ('connection', 'Survey DB', 'db.example.test', 5432, 'survey', 'reader', 'opaque-encrypted-envelope', '${now}');`);
});
afterEach(() => db.close());
const work = () => ["projects", "maps", "data_tables", "project_datasets", "recipes", "pg_connections"]
  .map(table => db.prepare(`SELECT * FROM ${table}`).all());

it("adopts legacy preferences once and retires only personal settings inside first-account creation", async () => {
  const before = work();
  const first = await createFirstAccount(input, db);
  expect(accountViewPrefs(first.account.id, db)).toEqual(prefs);
  expect(getSetting("display_name", db)).toBeNull();
  expect(getSetting("view_prefs", db)).toBeNull();
  expect(getSetting("instance_name", db)).toBe("Field atlas");
  expect(first.account).toMatchObject({ name: input.name, isOriginal: true, isAdmin: true });
  expect(work()).toEqual(before);
});

it("rolls adoption, account, original marker and session back together, leaving setup retryable", async () => {
  db.exec("CREATE TRIGGER reject_adoption BEFORE INSERT ON account_preferences BEGIN SELECT RAISE(ABORT, 'adoption failure'); END");
  const before = work();
  await expect(createFirstAccount(input, db)).rejects.toThrow("adoption failure");
  expect(accountCount(db)).toBe(0);
  expect(db.prepare("SELECT * FROM original_account").all()).toEqual([]);
  expect(db.prepare("SELECT * FROM auth_sessions").all()).toEqual([]);
  expect(getSetting("display_name", db)).toBe("Legacy name");
  expect(getSetting("view_prefs", db)).toBe(JSON.stringify(prefs));
  expect(work()).toEqual(before);
  db.exec("DROP TRIGGER reject_adoption");
  const retried = await createFirstAccount(input, db);
  expect(accountViewPrefs(retried.account.id, db)).toEqual(prefs);
});
