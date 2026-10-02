import { afterEach, beforeEach, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { open } from "./db";
import { insertMap, type MapRecord } from "./maps";
import { insertTable, type DataTable } from "./tables";
import { createRecipe } from "./recipes";
import { createProject } from "./projects";
import { insertConnection } from "./connections";
import { insertJob, type OperationJob } from "./jobs";
import { testAccountScope } from "@/lib/test-support/accounts";
import type { AccountScope } from "@/lib/auth/scope";

let db: Database;
beforeEach(() => { db = open(":memory:"); });
afterEach(() => { db.close(); });
const now = "2026-01-01T00:00:00.000Z";
const map: MapRecord = {
  id: "map", name: "Private map", viewport: { lng: 0, lat: 0, zoom: 1 }, basemap: null,
  customBasemap: null, basemapLayers: null, note: null, legendCorner: null, legendOrder: null,
  timeline: null, widgets: [], widgetsPublished: true, publishToken: null, publishedAt: null, published: false,
  createdAt: now, updatedAt: now,
};
const table: DataTable = {
  id: "table", name: "roads", sourceFilename: "roads.csv", file: "tables/roads.parquet", format: "csv",
  geometryColumn: null, geometryType: null, crsAssumed: false, headerSuspect: false,
  rowCount: 4, createdAt: now, source: "upload", sourceParams: null, importedAt: now,
};
const connection = { id: "connection", name: "Survey DB", host: "db.example.test", port: 5432,
  database: "survey", username: "reader", password: "secret", ssl: true };
const job: OperationJob = { id: "job", subjectKind: "run", subjectId: "job", operation: "sql",
  parameters: null, state: "queued", errorCode: null, errorMessage: null, outputId: null,
  outputName: null, acceptedAt: now, startedAt: null, finishedAt: null };

it.each([
  ["maps", () => insertMap(undefined!, map, db)],
  ["data_tables", () => insertTable(undefined!, table, db)],
  ["recipes", () => createRecipe(undefined!, "Workflow", db)],
  ["projects", () => createProject(undefined!, { name: "Survey" }, db)],
  ["pg_connections", () => insertConnection(undefined!, connection, db)],
  ["operation_jobs", () => insertJob(undefined!, job, db)],
] as const)("refuses %s creation without account scope before writing", (kind, create) => {
  expect(create).toThrowError(expect.objectContaining({ code: "authentication_required", status: 401 }));
  expect(db.prepare(`SELECT count(*) AS n FROM ${kind}`).get()).toEqual({ n: 0 });
});

const creators = [
  ["maps", (scope: AccountScope) => insertMap(scope, { ...map, ownerId: "other" } as MapRecord, db)],
  ["data_tables", (scope: AccountScope) => insertTable(scope, { ...table, ownerId: "other" } as DataTable, db)],
  ["recipes", (scope: AccountScope) => createRecipe(scope, "Workflow", db)],
  ["projects", (scope: AccountScope) => createProject(scope, { name: "Survey", ownerId: "other" } as { name: string }, db)],
  ["pg_connections", (scope: AccountScope) => insertConnection(scope, { ...connection, ownerId: "other" } as typeof connection, db)],
  ["operation_jobs", (scope: AccountScope) => insertJob(scope, { ...job, ownerId: "other" } as OperationJob, db)],
] as const;

it.each(creators)("stamps %s from the authenticated creator, independently of the first account", (kind, create) => {
  testAccountScope(db, "first");
  const scope = testAccountScope(db, "creator");
  testAccountScope(db, "other");
  create(scope);
  expect(db.prepare(`SELECT owner_id FROM ${kind}`).all()).toEqual([{ owner_id: "creator" }]);
});

it.each(creators)("refuses forged and deactivated scopes before %s creation", (kind, create) => {
  const scope = testAccountScope(db);
  expect(() => create({ accountId: scope.accountId } as AccountScope))
    .toThrowError(expect.objectContaining({ code: "authentication_required" }));
  db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = ?").run(scope.accountId);
  expect(() => create(scope)).toThrowError(expect.objectContaining({ code: "authentication_required" }));
  expect(db.prepare(`SELECT count(*) AS n FROM ${kind}`).get()).toEqual({ n: 0 });
});
