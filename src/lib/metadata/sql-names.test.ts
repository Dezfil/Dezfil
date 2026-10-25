import { describe, expect, it } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import Database from "better-sqlite3";
import {
  allocateSqlName, allocateSqlNames, baseSqlName, isReservedSqlName, isValidSqlName,
  RESERVED_SQL_NAME_PREFIXES, RESERVED_SQL_NAMES, SQL_NAME_FALLBACK, sqlNameCondition,
} from "./sql-names";

const free = () => false;

describe("the SQL-name derivation", () => {
  it.each([
    ["Ada Lovelace", "ada@example.test", "ada_lovelace"],
    ["  Ada   Lovelace  ", "ada@example.test", "ada_lovelace"],
    ["José Ñúñez-García", "jose@example.test", "jose_nunez_garcia"],
    ["O'Brien & Sons, Ltd.", "ob@example.test", "o_brien_sons_ltd"],
    ["ADA__LOVELACE", "ada@example.test", "ada_lovelace"],
    ["42 Club", "club@example.test", "u42_club"],
    ["7", "seven.days@example.test", "seven_days"],
    ["!!!", "field.notes+maps@example.test", "field_notes_maps"],
    ["دریا", "darya@example.test", "darya"],
    ["Bo", "bo@example.test", SQL_NAME_FALLBACK],
    ["", "", SQL_NAME_FALLBACK],
    ["DuckDB Fan", "fan@example.test", "fan"],
    ["pg admin", "pg_admin@example.test", "user"],
    ["a".repeat(40), "long@example.test", "a".repeat(32)],
    [`${"b".repeat(31)} c`, "long@example.test", "b".repeat(31)],
  ])("derives %j (email %j) as %j", (name, email, expected) => {
    expect(baseSqlName({ name, email })).toBe(expected);
    expect(isValidSqlName(allocateSqlName({ name, email }, free))).toBe(true);
  });

  it("suffixes a collision with the smallest free number, keeping the length bound", () => {
    const taken = new Set(["ada", "ada2", "ada3"]);
    expect(allocateSqlName({ name: "Ada", email: "a@example.test" }, n => taken.has(n))).toBe("ada4");
    const long = "c".repeat(32);
    expect(allocateSqlName({ name: long, email: "c@example.test" }, n => n === long)).toBe(`${"c".repeat(31)}2`);
    expect(allocateSqlName({ name: "", email: "" }, n => n === SQL_NAME_FALLBACK)).toBe(`${SQL_NAME_FALLBACK}2`);
  });

  it.each(RESERVED_SQL_NAMES)("never yields the reserved name %j, suffixing it instead", reserved => {
    expect(isReservedSqlName(reserved)).toBe(true);
    expect(isValidSqlName(reserved)).toBe(false);
    const name = reserved.replaceAll("_", " ");
    const allocated = allocateSqlName({ name, email: "x@example.test" }, free);
    expect(isValidSqlName(allocated)).toBe(true);
    if (!RESERVED_SQL_NAME_PREFIXES.some(prefix => reserved.startsWith(prefix))) expect(allocated).toBe(`${reserved}2`);
  });

  it.each(RESERVED_SQL_NAME_PREFIXES)("never yields a name with the reserved prefix %j", prefix => {
    expect(isReservedSqlName(`${prefix}anything`)).toBe(true);
    const allocated = allocateSqlName({ name: `${prefix} tables`, email: `${prefix}x@example.test` }, free);
    expect(allocated.startsWith(prefix)).toBe(false);
    expect(isValidSqlName(allocated)).toBe(true);
  });

  it("reserves every catalogue and schema name the query engine reports", async () => {
    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    try {
      const names = new Set<string>();
      for (const sql of ["SELECT database_name AS name FROM duckdb_databases()", "SELECT schema_name AS name FROM duckdb_schemas()"]) {
        for (const row of (await connection.runAndReadAll(sql)).getRowObjectsJson()) names.add(String(row.name));
      }
      expect(names.size).toBeGreaterThan(0);
      for (const name of names) expect(isReservedSqlName(name), name).toBe(true);
    } finally { connection.closeSync(); instance.closeSync(); }
  });

  it("reserves the qualifier the engine gives a keyed recursive CTE's previous iteration", async () => {
    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    try {
      // Inside a keyed recursive CTE the engine reads `recurring.<cte>` as the
      // CTE itself, so a person named "recurring" could not be addressed there.
      const rows = (await connection.runAndReadAll(`WITH RECURSIVE t(k, v) USING KEY (k) AS (
          SELECT 1, 1 UNION SELECT k, v + 1 FROM recurring.t WHERE v < 3) SELECT v FROM t`)).getRowObjectsJson();
      expect(rows).toEqual([{ v: 3 }]);
    } finally { connection.closeSync(); instance.closeSync(); }
    expect(isReservedSqlName("recurring")).toBe(true);
    expect(isValidSqlName("recurring")).toBe(false);
    expect(baseSqlName({ name: "Recurring", email: "r@example.test" })).toBe("recurring");
    expect(allocateSqlName({ name: "Recurring", email: "r@example.test" }, free)).toBe("recurring2");
    expect(allocateSqlNames([{ id: "r", name: "RECURRING", email: "r@example.test", createdAt: "2026-01-01" }])).toEqual({ r: "recurring2" });
    // Only the exact name is reserved: a longer name that starts with it is an ordinary name.
    expect(allocateSqlName({ name: "Recurring Costs", email: "r@example.test" }, free)).toBe("recurring_costs");
  });

  it("allocates a set oldest first and independently of row order", () => {
    const accounts = [
      { id: "b", name: "Ada", email: "b@example.test", createdAt: "2026-01-02" },
      { id: "a", name: "Ada", email: "a@example.test", createdAt: "2026-01-02" },
      { id: "c", name: "Ada", email: "c@example.test", createdAt: "2026-01-01" },
      { id: "d", name: "main", email: "d@example.test", createdAt: "2026-01-03" },
    ];
    const names = allocateSqlNames(accounts);
    expect(names).toEqual({ c: "ada", a: "ada2", b: "ada3", d: "main2" });
    expect(allocateSqlNames([...accounts].reverse())).toEqual(names);
    expect(allocateSqlNames(accounts.slice(0, 1), ["ada"])).toEqual({ b: "ada2" });
  });

  it("states the same rule to the metadata store", () => {
    const db = new Database(":memory:");
    try {
      const valid = (name: string) =>
        (db.prepare(`SELECT ${sqlNameCondition("n")} AS ok FROM (SELECT ? AS n)`).get(name) as { ok: number }).ok === 1;
      for (const name of ["ada", "ada_lovelace", "u42_club", "a".repeat(32), "main2", "pgx", "duck"]) {
        expect(valid(name), name).toBe(isValidSqlName(name));
        expect(valid(name), name).toBe(true);
      }
      for (const name of ["ab", "a".repeat(33), "1ada", "_ada", "Ada", "ada-x", "ada x", "adá", ...RESERVED_SQL_NAMES, "duckdb_x", "pg_x"]) {
        expect(valid(name), name).toBe(isValidSqlName(name));
        expect(valid(name), name).toBe(false);
      }
    } finally { db.close(); }
  });
});
