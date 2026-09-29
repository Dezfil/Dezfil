import type { Database } from "better-sqlite3";
import { beforeEach, afterEach, expect, it } from "vitest";
import { open } from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import type { AccountScope } from "./scope";
import { requireOwnedResource, type OwnedResourceKind } from "./owned-resource";
import { errorResponse } from "@/lib/api/errors";

let db: Database;
let scopes: Record<string, AccountScope>;
const kinds: OwnedResourceKind[] = ["map", "dataset", "workflow", "connection", "project", "job", "layer", "step", "history", "cascade"];
beforeEach(() => {
  db = open(":memory:");
  scopes = Object.fromEntries(["alice", "bob", "admin"].map(id => [id, testAccountScope(db, id)]));
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
  for (const id of Object.keys(scopes)) {
    db.exec(`INSERT INTO maps (id, name, created_at, updated_at, owner_id) VALUES ('${id}-map', '${id}', 'time', 'time', '${id}');
      INSERT INTO projects (id, name, created_at, updated_at, owner_id) VALUES ('${id}-project', '${id}', 'time', 'time', '${id}');
      INSERT INTO data_tables (id, name, format, file, row_count, created_at, owner_id) VALUES ('${id}-dataset', '${id}', 'geoparquet', 'tables/${id}.parquet', 1, 'time', '${id}');
      INSERT INTO recipes (id, name, created_at, updated_at, owner_id) VALUES ('${id}-workflow', '${id}', 'time', 'time', '${id}');
      INSERT INTO pg_connections (id, name, host, port, database, username, password_encrypted, created_at, owner_id)
        VALUES ('${id}-connection', '${id}', 'private-${id}.example.test', 5432, 'survey', 'reader', 'opaque-${id}', 'time', '${id}');
      INSERT INTO operation_jobs (id, subject_kind, subject_id, operation, state, accepted_at, owner_id)
        VALUES ('${id}-job', 'run', '${id}-job', 'sql_step', 'failed', 'time', '${id}');
      INSERT INTO layers (id, map_id, name, sql, style, ordinal, created_at, updated_at)
        VALUES ('${id}-layer', '${id}-map', '${id}', 'SELECT * FROM ${id}', '{}', 0, 'time', 'time');
      INSERT INTO recipe_steps (id, recipe_id, ordinal, operation, parameters, created_at, updated_at)
        VALUES ('${id}-step', '${id}-workflow', 0, 'sql_step', '{}', 'time', 'time');
      INSERT INTO map_history (id, map_id, seq, scope, target_id, op, created_at)
        VALUES ('${id}-history', '${id}-map', 1, 'map', '${id}-map', 'update', 'time');
      INSERT INTO cascade_runs (id, recipe_id, kind, started_at) VALUES ('${id}-cascade', '${id}-workflow', 'all', 'time');`);
  }
});
afterEach(() => db.close());
function failure(action: () => unknown) {
  try { action(); } catch (error) { return error; }
  throw new Error("Expected a refusal");
}
function snapshot() {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
    .map(({ name }) => db.prepare(`SELECT * FROM ${name}`).all());
}

it.each(kinds)("requires an explicit active account scope for a %s lookup", kind => {
  const before = snapshot();
  for (const scope of [undefined, null, { accountId: "alice" }]) {
    expect(failure(() => requireOwnedResource(scope as AccountScope, kind, `alice-${kind}`, db)))
      .toMatchObject({ code: "authentication_required", status: 401 });
  }
  expect(snapshot()).toEqual(before);
});

it.each(kinds)("resolves only each owner's %s and refuses hidden like missing, including for admins", async kind => {
  const before = snapshot();
  for (const [account, scope] of Object.entries(scopes)) {
    expect(requireOwnedResource(scope, kind, `${account}-${kind}`, db)).toBe(`${account}-${kind}`);
    for (const other of Object.keys(scopes).filter(id => id !== account)) {
      const hidden = failure(() => requireOwnedResource(scope, kind, `${other}-${kind}`, db));
      const missing = failure(() => requireOwnedResource(scope, kind, "missing", db));
      expect(hidden).toMatchObject({ code: "not_found", status: 404 });
      const response = errorResponse(hidden);
      expect(response.status).toBe(errorResponse(missing).status);
      expect(await response.json()).toEqual(await errorResponse(missing).json());
      expect(JSON.stringify(hidden)).not.toMatch(/alice|bob|admin|parquet|opaque|example/);
    }
  }
  expect(snapshot()).toEqual(before);
});

it("rechecks account activity, preserving identity across deactivation and reactivation", () => {
  db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'alice'").run();
  expect(failure(() => requireOwnedResource(scopes.alice, "map", "alice-map", db)))
    .toMatchObject({ code: "authentication_required", status: 401 });
  expect(failure(() => requireOwnedResource(scopes.admin, "map", "alice-map", db)))
    .toMatchObject({ code: "not_found", status: 404 });
  db.prepare("UPDATE accounts SET status = 'active' WHERE id = 'alice'").run();
  expect(requireOwnedResource(scopes.alice, "map", "alice-map", db)).toBe("alice-map");
});
