import type { Database } from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { open } from "@/lib/metadata/db";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import { errorResponse } from "@/lib/api/errors";
import { listOwnedMaps } from "@/lib/metadata/map-queries";
import { listOwnedTables } from "@/lib/metadata/owned-tables";
import { testAccountScope } from "@/lib/test-support/accounts";
import { requireOwnedResource } from "./owned-resource";
import type { AccountScope } from "./scope";
import {
  ACTION_RULES, AUTHORIZATION_BOUNDARIES, OWNER_QUERY_MODULES, PERMISSION_REFUSAL, SCHEMA_MODULES,
  canReach, permissionRefused, projectRole, reachableDatasetIds, requirePermitted, requireReachable,
  type ReachKind,
} from "./reach";

/**
 * The fixture: Pat owns project P with Ada and Ed as editors and Vi as a
 * viewer. Ada files her map, workflow and dataset into P, keeps an unfiled
 * map and a dataset in a project of her own; Out belongs to nothing and is an
 * admin. People rows are written directly: no route adds them yet.
 */
let db: Database;
let scopes: Record<string, AccountScope>;
const now = "2026-01-01T00:00:00.000Z";
beforeEach(() => {
  db = open(":memory:");
  scopes = Object.fromEntries(["pat", "ada", "ed", "vi", "out"].map(id => [id, testAccountScope(db, id)]));
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'out'").run();
  db.exec(`INSERT INTO projects (id, name, created_at, updated_at, owner_id) VALUES ('P', 'Survey', '${now}', '${now}', 'pat'),
      ('P2', 'Ada only', '${now}', '${now}', 'ada');
    INSERT INTO project_people VALUES ('P', 'ada', 'editor', '${now}'), ('P', 'ed', 'editor', '${now}'), ('P', 'vi', 'viewer', '${now}');
    INSERT INTO maps (id, name, created_at, updated_at, owner_id, project_id) VALUES ('A', 'Filed', '${now}', '${now}', 'ada', 'P'),
      ('U', 'Unfiled', '${now}', '${now}', 'ada', NULL);
    INSERT INTO layers (id, map_id, name, sql, style, ordinal, created_at, updated_at)
      VALUES ('A-layer', 'A', 'Roads', 'SELECT 1', '{}', 0, '${now}', '${now}'), ('U-layer', 'U', 'Roads', 'SELECT 1', '{}', 0, '${now}', '${now}');
    INSERT INTO map_history (id, map_id, seq, scope, target_id, op, created_at) VALUES ('A-history', 'A', 1, 'map', 'A', 'update', '${now}'),
      ('U-history', 'U', 1, 'map', 'U', 'update', '${now}');
    INSERT INTO recipes (id, name, origin, created_at, updated_at, owner_id, project_id) VALUES ('W', 'Filed', 'workflow', '${now}', '${now}', 'ada', 'P'),
      ('V', 'Unfiled', 'workflow', '${now}', '${now}', 'ada', NULL);
    INSERT INTO recipe_steps (id, recipe_id, ordinal, operation, parameters, created_at, updated_at)
      VALUES ('W-step', 'W', 0, 'sql_step', '{}', '${now}', '${now}'), ('V-step', 'V', 0, 'sql_step', '{}', '${now}', '${now}');
    INSERT INTO cascade_runs (id, recipe_id, kind, started_at) VALUES ('W-run', 'W', 'single', '${now}'), ('V-run', 'V', 'single', '${now}');
    INSERT INTO data_tables (id, name, format, file, row_count, created_at, owner_id) VALUES ('D', 'roads', 'geoparquet', 'tables/d.parquet', 1, '${now}', 'ada'),
      ('D2', 'rivers', 'geoparquet', 'tables/d2.parquet', 1, '${now}', 'ada'), ('E', 'roads', 'geoparquet', 'tables/e.parquet', 1, '${now}', 'ed');
    INSERT INTO project_datasets VALUES ('P', 'D', '${now}'), ('P2', 'D2', '${now}');`);
});
afterEach(() => db.close());

function failure(action: () => unknown): { code: string; status: number; message: string } {
  try { action(); } catch (error) { return error as { code: string; status: number; message: string }; }
  throw new Error("Expected a refusal");
}
async function wire(action: () => unknown) {
  const response = errorResponse(failure(action));
  return { status: response.status, body: await response.json() };
}

const reach: [ReachKind, string, string[]][] = [
  ["map", "A", ["ada", "pat", "ed", "vi"]], ["map", "U", ["ada"]],
  ["layer", "A-layer", ["ada", "pat", "ed", "vi"]], ["layer", "U-layer", ["ada"]],
  ["history", "A-history", ["ada", "pat", "ed", "vi"]], ["history", "U-history", ["ada"]],
  ["workflow", "W", ["ada", "pat", "ed", "vi"]], ["workflow", "V", ["ada"]],
  ["step", "W-step", ["ada", "pat", "ed", "vi"]], ["step", "V-step", ["ada"]],
  ["cascade", "W-run", ["ada", "pat", "ed", "vi"]], ["cascade", "V-run", ["ada"]],
  ["dataset", "D", ["ada", "pat", "ed", "vi"]], ["dataset", "D2", ["ada"]], ["dataset", "E", ["ed"]],
  ["project", "P", ["pat", "ada", "ed", "vi"]], ["project", "P2", ["ada"]],
];

describe("the reach kernel", () => {
  it.each(reach)("reaches %s %s for exactly its owner and the people of its project", (kind, id, who) => {
    for (const account of Object.keys(scopes)) {
      expect(canReach(scopes[account], kind, id, db), `${account} ${kind} ${id}`).toBe(who.includes(account));
      if (who.includes(account)) expect(requireReachable(scopes[account], kind, id, db).id).toBe(id);
    }
  });

  it.each(reach)("refuses %s %s to everyone else exactly as a missing identity, admins included", async (kind, id, who) => {
    for (const account of Object.keys(scopes).filter(name => !who.includes(name))) {
      const hidden = await wire(() => requireReachable(scopes[account], kind, id, db));
      expect(hidden).toEqual(await wire(() => requireReachable(scopes[account], kind, "missing", db)));
      expect(hidden).toEqual({ status: 404, body: { error: { code: "not_found", message: ERROR_CATALOGUE.not_found } } });
    }
  });

  it("names each account's role on a project", () => {
    expect(Object.fromEntries(Object.keys(scopes).map(account => [account, projectRole(scopes[account], "P", db)])))
      .toEqual({ pat: "owner", ada: "editor", ed: "editor", vi: "viewer", out: "none" });
    expect(projectRole(scopes.ada, "P2", db)).toBe("owner");
    expect(projectRole(scopes.pat, "P2", db)).toBe("none");
    expect(projectRole(scopes.pat, "missing", db)).toBe("none");
  });

  it("lists the dataset identities each account reaches", () => {
    const sets = Object.fromEntries(Object.keys(scopes).map(account => [account, [...reachableDatasetIds(scopes[account], db)].sort()]));
    expect(sets).toEqual({ pat: ["D"], ada: ["D", "D2"], ed: ["D", "E"], vi: ["D"], out: [] });
  });

  it("requires an explicit active scope for every question", () => {
    for (const scope of [undefined, null, { accountId: "ada" }] as unknown as AccountScope[]) {
      expect(failure(() => canReach(scope, "map", "A", db))).toMatchObject({ code: "authentication_required", status: 401 });
      expect(failure(() => reachableDatasetIds(scope, db))).toMatchObject({ code: "authentication_required" });
    }
    db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'ed'").run();
    expect(failure(() => requireReachable(scopes.ed, "map", "A", db))).toMatchObject({ code: "authentication_required" });
  });

  it("follows a membership change on the next question", () => {
    expect(canReach(scopes.vi, "map", "A", db)).toBe(true);
    db.prepare("DELETE FROM project_people WHERE account_id = 'vi'").run();
    expect(canReach(scopes.vi, "map", "A", db)).toBe(false);
    db.prepare("UPDATE maps SET project_id = NULL WHERE id = 'A'").run();
    expect(canReach(scopes.ed, "map", "A", db)).toBe(false);
    expect(canReach(scopes.pat, "map", "A", db)).toBe(false);
    expect(canReach(scopes.ada, "map", "A", db)).toBe(true);
  });
});

describe("action permission", () => {
  it("lets the owner, the project's owner and an editor change content, and refuses a viewer by the permission shape", async () => {
    for (const [kind, id] of [["map", "A"], ["layer", "A-layer"], ["history", "A-history"], ["workflow", "W"], ["step", "W-step"]] as const) {
      for (const account of ["ada", "pat", "ed"]) expect(requirePermitted(scopes[account], kind, id, "edit", db).id, `${account} ${kind}`).toBe(id);
      const refused = await wire(() => requirePermitted(scopes.vi, kind, id, "edit", db));
      expect(refused).toEqual({ status: 403, body: { error: { code: "forbidden", message: PERMISSION_REFUSAL } } });
      expect(await wire(() => requirePermitted(scopes.out, kind, id, "edit", db)))
        .toEqual(await wire(() => requirePermitted(scopes.out, kind, "missing", "edit", db)));
    }
  });

  it("keeps deletion, publication and transfer the owner's, refusing everyone else who reaches it", async () => {
    for (const action of ["delete", "publish", "transfer"] as const) {
      expect(requirePermitted(scopes.ada, "map", "A", action, db).relation).toBe("owner");
      for (const account of ["pat", "ed", "vi"]) {
        expect(await wire(() => requirePermitted(scopes[account], "map", "A", action, db)), `${account} ${action}`)
          .toEqual({ status: 403, body: { error: { code: "forbidden", message: PERMISSION_REFUSAL } } });
      }
      expect((await wire(() => requirePermitted(scopes.out, "map", "A", action, db))).status).toBe(404);
    }
    for (const action of ["delete", "transfer"] as const) {
      expect(requirePermitted(scopes.ada, "workflow", "W", action, db).id).toBe("W");
      expect(failure(() => requirePermitted(scopes.pat, "workflow", "W", action, db))).toMatchObject({ code: "forbidden", status: 403 });
    }
    for (const action of ["mutate", "refresh", "delete"] as const) {
      expect(requirePermitted(scopes.ada, "dataset", "D", action, db).id).toBe("D");
      for (const account of ["pat", "ed", "vi"]) {
        expect(failure(() => requirePermitted(scopes[account], "dataset", "D", action, db))).toMatchObject({ code: "forbidden" });
      }
    }
  });

  it("freezes a deactivated owner's content for everyone who still reaches it, and keeps it reachable", async () => {
    db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'ada'").run();
    for (const account of ["pat", "ed", "vi"]) {
      expect(canReach(scopes[account], "map", "A", db)).toBe(true);
      expect(failure(() => requirePermitted(scopes[account], "map", "A", "edit", db))).toMatchObject({ code: "forbidden", status: 403 });
      expect(failure(() => requirePermitted(scopes[account], "workflow", "W", "edit", db))).toMatchObject({ code: "forbidden" });
    }
    // A run reads the frozen space and changes nothing of the workflow's own.
    expect(requirePermitted(scopes.ed, "workflow", "W", "run", db).frozen).toBe(true);
    db.prepare("UPDATE accounts SET status = 'active' WHERE id = 'ada'").run();
    expect(requirePermitted(scopes.ed, "map", "A", "edit", db).frozen).toBe(false);
  });

  it("names the project actions: rename, note, dissolution, membership and transfer are the owner's", () => {
    for (const action of ["rename", "note", "dissolve", "membership", "transfer"] as const) {
      expect(requirePermitted(scopes.pat, "project", "P", action, db).relation).toBe("owner");
      for (const account of ["ada", "ed", "vi"]) {
        expect(failure(() => requirePermitted(scopes[account], "project", "P", action, db)), `${account} ${action}`)
          .toMatchObject({ code: "forbidden", status: 403, message: PERMISSION_REFUSAL });
      }
      expect(failure(() => requirePermitted(scopes.out, "project", "P", action, db))).toMatchObject({ code: "not_found" });
    }
  });

  it("states every rule as data, over relations the kernel can produce", () => {
    const relations = new Set(["owner", "project-owner", "editor", "viewer"]);
    for (const [family, actions] of Object.entries(ACTION_RULES)) {
      for (const [action, rule] of Object.entries(actions)) {
        expect(rule.by.length, `${family} ${action}`).toBeGreaterThan(0);
        for (const relation of rule.by) expect(relations.has(relation), `${family} ${action} ${relation}`).toBe(true);
      }
    }
  });
});

describe("the permission refusal", () => {
  it("is one plain sentence with no detail, under the forbidden code the catalogue documents", async () => {
    expect(PERMISSION_REFUSAL).toMatch(/^[A-Z][^.]*\.$/);
    expect(PERMISSION_REFUSAL).not.toMatch(/—|–/);
    const response = errorResponse(permissionRefused());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: "forbidden", message: PERMISSION_REFUSAL } });
    expect(ERROR_CATALOGUE.forbidden).toMatch(/view.*not make|not permitted/i);
    expect(ERROR_CATALOGUE.forbidden).toContain("change");
  });
});

describe("what this kernel does not change", () => {
  it("leaves every owner-only read refusing the people of a project", () => {
    for (const account of ["pat", "ed", "vi"]) {
      expect(failure(() => requireOwnedResource(scopes[account], "map", "A", db))).toMatchObject({ code: "not_found" });
      expect(listOwnedMaps(scopes[account], db).map(map => map.id)).not.toContain("A");
      expect(listOwnedTables(scopes[account], db).map(table => table.id)).not.toContain("D");
    }
  });
});

describe("the authorization boundaries", () => {
  it("assign every kind to exactly one boundary", () => {
    const kinds = Object.values(AUTHORIZATION_BOUNDARIES).flat();
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(AUTHORIZATION_BOUNDARIES.projectReachable).toEqual(
      expect.arrayContaining(["map", "layer", "widget", "history", "workflow", "step", "cascade", "dataset", "project"]));
    expect(AUTHORIZATION_BOUNDARIES.ownerOnly).toEqual(expect.arrayContaining(["connection", "dataset-mutation", "dataset-refresh"]));
    expect(AUTHORIZATION_BOUNDARIES.initiatorPrivate).toEqual(
      expect.arrayContaining(["job", "receipt", "render", "prepared-download", "assistant-run"]));
  });

  it("hold every metadata and authentication module that queries by owner, and nothing stale", () => {
    const modules = ["src/lib/metadata", "src/lib/auth"].flatMap(dir => readdirSync(dir)
      .filter(file => /\.(ts|mjs)$/.test(file) && !/\.test\.ts$/.test(file) && !file.endsWith(".d.mts"))
      .map(file => path.join(dir, file)));
    const querying = modules.filter(file => /\bowner_id\b/.test(readFileSync(file, "utf8"))).sort();
    expect(querying.length).toBeGreaterThan(10);
    const inventoried = [...Object.keys(OWNER_QUERY_MODULES), ...SCHEMA_MODULES].sort();
    expect(querying).toEqual(inventoried);
    const boundaries = new Set(Object.keys(AUTHORIZATION_BOUNDARIES));
    for (const [file, assigned] of Object.entries(OWNER_QUERY_MODULES)) {
      expect(assigned.length, file).toBeGreaterThan(0);
      for (const boundary of assigned) expect(boundaries.has(boundary), `${file} ${boundary}`).toBe(true);
    }
  });
});
