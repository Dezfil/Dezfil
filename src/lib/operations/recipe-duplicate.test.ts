import { DuckDBInstance } from "@duckdb/node-api";
import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { addStep, createRecipe, listRecipes, listSteps } from "@/lib/metadata/recipes";
import { resetQueryInstance } from "@/lib/duckdb";
import { testAccountScope } from "@/lib/test-support/accounts";
import { duplicateRecipe } from "./recipe-duplicate";

let db: Database;
beforeEach(() => {
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
});
afterEach(() => { resetQueryInstance(); vi.restoreAllMocks(); db.close(); });

it.each([
  "SELECT a.x FROM a",
  "WITH a_copy AS (SELECT 99 AS x) SELECT a.x FROM a",
  "WITH a AS (SELECT a.x FROM a) SELECT a.x FROM a",
])("executes a copied qualified output reference: %s", async sql => {
  const scope = testAccountScope(db), source = createRecipe(scope, "Source", db);
  addStep(source.id, { operation: "sql_step", parameters: { sql: "SELECT 7 AS x", name: "a" } }, db);
  addStep(source.id, { operation: "sql_step", parameters: { sql, name: "b" } }, db);
  const copy = await duplicateRecipe(scope, source.id);
  const [producer, consumer] = listSteps(copy.id, db);
  const engine = await DuckDBInstance.create(":memory:"), conn = await engine.connect();
  try {
    await conn.run(`CREATE TABLE "${producer.parameters.name}" AS ${producer.parameters.sql}`);
    const result = await conn.runAndReadAll(String(consumer.parameters.sql));
    expect(result.getRowObjectsJson()).toEqual([{ x: 7 }]);
  } finally { conn.closeSync(); engine.closeSync(); }
});

it("refuses a rename that would strand a schema-qualified column before writing a copy", async () => {
  const scope = testAccountScope(db), source = createRecipe(scope, "Source", db);
  addStep(source.id, { operation: "sql_step", parameters: { sql: "SELECT 7 AS x", name: "a" } }, db);
  addStep(source.id, { operation: "sql_step", parameters: { sql: "SELECT main.a.x FROM a", name: "b" } }, db);
  await expect(duplicateRecipe(scope, source.id)).rejects.toMatchObject({ code: "invalid_request" });
  expect(listRecipes(db).map(recipe => recipe.id)).toEqual([source.id]);
});

it("keeps rewritten output bindings when a copied SQL step is unfinished", async () => {
  const scope = testAccountScope(db), source = createRecipe(scope, "Source", db);
  addStep(source.id, { operation: "sql_step", parameters: { sql: "SELECT 7 AS x", name: "a" } }, db);
  addStep(source.id, { operation: "sql_step", parameters: { sql: "SELECT a.x FROM a WHERE", name: "b" } }, db);
  const copy = await duplicateRecipe(scope, source.id);
  const [producer, consumer] = listSteps(copy.id, db);
  expect(consumer.parameters.sql).toBe("SELECT a.x FROM a_copy AS a WHERE");
  const engine = await DuckDBInstance.create(":memory:"), conn = await engine.connect();
  try {
    await conn.run("CREATE TABLE a AS SELECT 99 AS x");
    await conn.run(`CREATE TABLE "${producer.parameters.name}" AS ${producer.parameters.sql}`);
    const result = await conn.runAndReadAll(`${consumer.parameters.sql} a.x > 0`);
    expect(result.getRowObjectsJson()).toEqual([{ x: 7 }]);
  } finally { conn.closeSync(); engine.closeSync(); }
});
