import Database from "better-sqlite3";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb, MIGRATIONS, open } from "@/lib/metadata/db";
import { IDENTITIES_MIGRATION, rebuildIdentities } from "@/lib/metadata/migrations-identities";
import { allocateSqlNames, type SqlNameIdentity } from "@/lib/metadata/sql-names";
import { accountLabels, getAccount, listAccounts } from "@/lib/metadata/accounts";
import { accountActors } from "@/lib/metadata/account-actors";
import { transferProject } from "@/lib/metadata/transfers";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { createMap } from "@/lib/map-service";
import { createRecipe } from "@/lib/metadata/recipes";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { shareProject } from "@/lib/test-support/sharing";
import type { AccountScope } from "@/lib/auth/scope";

/**
 * The picture's version on every person the faces draw from.
 *
 * Ada has a picture and owns project P, where Bob (no picture) edits and Cyd
 * (a picture, deactivated) views. Ada's dataset, map and workflow are filed in
 * P. Bob owns project Q with Ada as its editor. Every read a face is drawn
 * from carries Ada's version, nobody without a picture carries the key, and
 * a replaced picture is the next read's new version. The words that name a
 * person (a change's author, a run's runner, a deleted actor) stay as they
 * were: no version.
 */
const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
let scopes: Record<string, AccountScope>;
let ids: { dataset: string; map: string; workflow: string };
const ADA = { name: "Ada Lovelace", sqlName: "ada" };
const BOB = { name: "Bob Builder", sqlName: "bob" };

beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "picture-people-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb(); resetQueryInstance();
  scopes = Object.fromEntries(["ada", "bob", "cyd", "admin"].map((id) => [id, testAccountScope(undefined, id)]));
  const db = metadataDb();
  db.exec(`UPDATE accounts SET name = 'Ada Lovelace', picture_version = 'ada-1' WHERE id = 'ada';
    UPDATE accounts SET name = 'Bob Builder' WHERE id = 'bob';
    UPDATE accounts SET name = 'Cyd Gone', picture_version = 'cyd-1' WHERE id = 'cyd';
    UPDATE accounts SET is_admin = 1 WHERE id = 'admin'`);
  const file = path.join(directory, "roads.csv");
  await writeFile(file, "sentinel,lon,lat\nroad,1,2\n");
  const dataset = (await ingestFile(scopes.ada, file, "roads.csv")).id;
  const map = createMap(scopes.ada, "Survey map").id;
  const workflow = createRecipe(scopes.ada, "Survey flow").id;
  shareProject("ada", "P", [["bob", "editor"], ["cyd", "viewer"]], [dataset]);
  shareProject("bob", "Q", [["ada", "editor"]]);
  db.prepare("UPDATE maps SET project_id = 'P' WHERE id = ?").run(map);
  db.prepare("UPDATE recipes SET project_id = 'P' WHERE id = ?").run(workflow);
  db.exec("UPDATE accounts SET status = 'deactivated' WHERE id = 'cyd'");
  ids = { dataset, map, workflow };
});
afterEach(async () => { closeMetadataDb(); resetQueryInstance(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function call(account: string, route: Promise<Record<string, unknown>>, method: string, url: string,
  params: Record<string, string> = {}, body?: unknown) {
  const handler = (await route)[method] as Handler;
  const request = new Request(`http://instance.test${url}`, body === undefined ? { method } :
    { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  const response = await handler(testAccountRequest(request, undefined, account), { params: Promise.resolve(params) });
  expect(response.status, `${method} ${url}`).toBe(200);
  return await response.json() as Record<string, unknown>;
}
const read = (account: string, route: Promise<Record<string, unknown>>, url: string, params?: Record<string, string>) =>
  call(account, route, "GET", url, params);
const named = <T extends { id?: string; name?: string }>(list: T[], key: string) => list.find((item) => item.id === key || item.name === key)!;

describe("the column", () => {
  it("is null on every account of a fresh store, and on every account an upgraded store held", () => {
    const fresh = open(":memory:");
    testAccountScope(fresh, "fresh");
    expect(fresh.prepare("SELECT picture_version FROM accounts").all()).toEqual([{ picture_version: null }]);
    fresh.close();
    const file = path.join(directory, "older.sqlite");
    const old = new Database(file);
    old.pragma("journal_mode = WAL"); old.pragma("foreign_keys = ON");
    old.function("allocate_sql_names", { deterministic: true }, (accounts: unknown) =>
      JSON.stringify(allocateSqlNames(JSON.parse(String(accounts)) as SqlNameIdentity[])));
    // The store as it stood just before the picture's column.
    const pictureColumn = MIGRATIONS.findIndex((migration) => migration.includes("ADD COLUMN picture_version"));
    expect(pictureColumn).toBeGreaterThan(0);
    for (let version = 0; version < pictureColumn; version++) {
      if (MIGRATIONS[version] === IDENTITIES_MIGRATION) { rebuildIdentities(old, MIGRATIONS[version], version + 1); continue; }
      old.exec(MIGRATIONS[version]); old.pragma(`user_version = ${version + 1}`);
    }
    old.prepare(`INSERT INTO accounts (id, name, email, is_admin, status, created_at, updated_at, sql_name)
      VALUES ('old', 'Old Hand', 'old@example.test', 0, 'active', 'time', 'time', 'old_hand')`).run();
    expect((old.pragma("table_info(accounts)") as { name: string }[]).map((column) => column.name)).not.toContain("picture_version");
    old.close();
    const upgraded = open(file);
    expect(upgraded.prepare("SELECT id, picture_version FROM accounts").all()).toEqual([{ id: "old", picture_version: null }]);
    expect(getAccount("old", upgraded)).not.toHaveProperty("pictureVersion");
    upgraded.close();
  });

  it("upgrades a store that took the picture's column where it stands, adding every later column", () => {
    const file = path.join(directory, "picture-first.sqlite");
    const old = new Database(file);
    old.pragma("journal_mode = WAL"); old.pragma("foreign_keys = ON");
    old.function("allocate_sql_names", { deterministic: true }, (accounts: unknown) =>
      JSON.stringify(allocateSqlNames(JSON.parse(String(accounts)) as SqlNameIdentity[])));
    const pictureColumn = MIGRATIONS.findIndex((migration) => migration.includes("ADD COLUMN picture_version"));
    for (let version = 0; version <= pictureColumn; version++) {
      if (MIGRATIONS[version] === IDENTITIES_MIGRATION) { rebuildIdentities(old, MIGRATIONS[version], version + 1); continue; }
      old.exec(MIGRATIONS[version]); old.pragma(`user_version = ${version + 1}`);
    }
    expect((old.pragma("table_info(map_pictures)") as { name: string }[]).map((column) => column.name)).not.toContain("retired");
    old.close();
    const upgraded = open(file);
    expect(upgraded.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    expect((upgraded.pragma("table_info(map_pictures)") as { name: string }[]).map((column) => column.name)).toContain("retired");
    expect((upgraded.pragma("table_info(accounts)") as { name: string }[]).map((column) => column.name)).toContain("picture_version");
    upgraded.close();
  });

  it("can hold no version on a deleted account", () => {
    const db = metadataDb();
    db.exec("UPDATE accounts SET status = 'deleting' WHERE id = 'cyd'");
    expect(() => db.exec(`UPDATE accounts SET status = 'deleted', name = NULL, email = NULL, password_hash = NULL,
      is_admin = NULL, created_at = NULL, updated_at = NULL, last_sign_in_at = NULL WHERE id = 'cyd'`)).toThrow(/CHECK/);
    db.exec(`UPDATE accounts SET status = 'deleted', name = NULL, email = NULL, password_hash = NULL, is_admin = NULL,
      created_at = NULL, updated_at = NULL, last_sign_in_at = NULL, picture_version = NULL WHERE id = 'cyd'`);
    expect(() => db.exec("UPDATE accounts SET picture_version = 'again' WHERE id = 'cyd'")).toThrow(/CHECK/);
  });
});

describe("the reads a face is drawn from", () => {
  it("carry the version on the account, the Users list and the directory, and no key for a person without one", async () => {
    expect((await read("ada", import("@/app/api/account/route"), "/api/account")).account).toMatchObject({ id: "ada", pictureVersion: "ada-1" });
    expect((await read("bob", import("@/app/api/account/route"), "/api/account")).account).not.toHaveProperty("pictureVersion");
    const users = (await read("admin", import("@/app/api/users/route"), "/api/users")).users as { id: string }[];
    expect(named(users, "ada")).toMatchObject({ pictureVersion: "ada-1" });
    expect(named(users, "cyd")).toMatchObject({ status: "deactivated", pictureVersion: "cyd-1" });
    expect(named(users, "bob")).not.toHaveProperty("pictureVersion");
    const directory = (query: string) => read("bob", import("@/app/api/accounts/search/route"), `/api/accounts/search?q=${query}`);
    expect((await directory("Ada")).accounts).toEqual([{ ...ADA, pictureVersion: "ada-1" }]);
    expect((await directory("Cyd")).accounts).toEqual([]);
    expect((await read("ada", import("@/app/api/accounts/search/route"), "/api/accounts/search?q=Bob")).accounts).toEqual([BOB]);
  });

  it("carry the owner's version on maps, workflows, datasets, the catalogue and projects", async () => {
    const owner = { ...ADA, pictureVersion: "ada-1" };
    const maps = await read("bob", import("@/app/api/maps/route"), "/api/maps") as unknown as { id: string; owner: unknown }[];
    expect(named(maps, ids.map).owner).toEqual(owner);
    const map = await read("bob", import("@/app/api/maps/[id]/route"), `/api/maps/${ids.map}`, { id: ids.map });
    expect(map.owner).toEqual(owner);
    expect(map.lastChangedBy).toEqual(ADA);
    const workflows = (await read("bob", import("@/app/api/recipes/route"), "/api/recipes")).recipes as { id: string; owner: unknown }[];
    expect(named(workflows, ids.workflow).owner).toEqual(owner);
    const tables = await read("bob", import("@/app/api/tables/route"), "/api/tables") as unknown as { id: string; owner: unknown }[];
    expect(named(tables, ids.dataset).owner).toEqual(owner);
    const catalogue = (await read("bob", import("@/app/api/catalogue/tables/route"), "/api/catalogue/tables?columns=0")).tables as { id: string; owner: unknown }[];
    expect(named(catalogue, ids.dataset).owner).toEqual(owner);
    const projects = await read("bob", import("@/app/api/projects/route"), "/api/projects") as unknown as { id: string; owner: unknown }[];
    expect(named(projects, "P").owner).toEqual(owner);
    expect(named(projects, "Q").owner).toEqual(BOB);
  });

  it("carry each person's version on a project's people and on the answers to changing them", async () => {
    const people = import("@/app/api/projects/[id]/people/route");
    const person = import("@/app/api/projects/[id]/people/[sqlName]/route");
    const cyd = { name: "Cyd Gone", sqlName: "cyd", pictureVersion: "cyd-1", role: "viewer", deactivated: true };
    const listed = [{ ...ADA, pictureVersion: "ada-1", role: "owner", deactivated: false }, { ...BOB, role: "editor", deactivated: false }, cyd];
    expect((await read("ada", people, "/api/projects/P/people", { id: "P" })).people).toEqual(listed);
    const changed = await call("ada", person, "PUT", "/api/projects/P/people/bob", { id: "P", sqlName: "bob" }, { role: "viewer" });
    expect(changed.people).toEqual([listed[0], { ...listed[1], role: "viewer" }, cyd]);
    const removed = await call("ada", person, "DELETE", "/api/projects/P/people/cyd", { id: "P", sqlName: "cyd" });
    expect(removed.people).toEqual([listed[0], { ...listed[1], role: "viewer" }]);
    const theirs = await call("bob", person, "PUT", "/api/projects/Q/people/ada", { id: "Q", sqlName: "ada" }, { role: "viewer" });
    expect(theirs.people).toEqual([{ ...BOB, role: "owner", deactivated: false }, { ...ADA, pictureVersion: "ada-1", role: "viewer", deactivated: false }]);
  });

  it("carry the new owner's version on a transfer's answer", () => {
    expect(transferProject(scopes.bob, "Q", "ada").owner).toEqual({ ...ADA, pictureVersion: "ada-1" });
    expect(transferProject(scopes.ada, "P", "bob").owner).toEqual(BOB);
  });

  it("answer a replaced picture's new version at the next read, and none once it is removed", async () => {
    const owner = async () => (await read("bob", import("@/app/api/maps/[id]/route"), `/api/maps/${ids.map}`, { id: ids.map })).owner;
    metadataDb().exec("UPDATE accounts SET picture_version = 'ada-2' WHERE id = 'ada'");
    expect(await owner()).toEqual({ ...ADA, pictureVersion: "ada-2" });
    metadataDb().exec("UPDATE accounts SET picture_version = NULL WHERE id = 'ada'");
    expect(await owner()).toEqual(ADA);
    expect(listAccounts().find((account) => account.id === "ada")).not.toHaveProperty("pictureVersion");
  });
});

describe("the words that name a person", () => {
  it("stay a display name and a SQL name, or the deleted marker, with no version", () => {
    expect(accountLabels(["ada", "cyd"])).toEqual(new Map([["ada", ADA], ["cyd", { name: "Cyd Gone", sqlName: "cyd" }]]));
    expect(accountActors(["ada"])).toEqual(new Map([["ada", ADA]]));
    const db = metadataDb();
    db.exec(`UPDATE accounts SET status = 'deleted', name = NULL, email = NULL, password_hash = NULL, is_admin = NULL,
      created_at = NULL, updated_at = NULL, last_sign_in_at = NULL, picture_version = NULL WHERE id = 'cyd'`);
    expect(accountActors(["cyd"])).toEqual(new Map([["cyd", { deleted: true }]]));
  });
});
