import { describe, expect, it } from "vitest";
import {
  applyAutomatic,
  isEdited,
  quoteIdentifier,
  starterSql,
} from "./sql-draft";
import {
  HISTORY_CAP,
  addRun,
  groupByDay,
  isLong,
  removeRun,
  titleOf,
  type HistoryEntry,
} from "./sql-history";
import { SNIPPETS, SPATIAL_FUNCTIONS, renderSnippet } from "./sql-snippets";
import { matchTables } from "./table-search";
import type { TableListing } from "../api";

describe("the ownership rule", () => {
  const seed = starterSql("berlin_cafes");
  it("replaces a blank editor and an untouched seed", () => {
    expect(applyAutomatic("", null, seed)).toMatchObject({ text: seed, replaced: true, from: 0 });
    expect(applyAutomatic("   \n", null, seed)).toMatchObject({ replaced: true });
    const next = starterSql("districts");
    expect(applyAutomatic(seed, seed, next)).toMatchObject({ text: next, replaced: true });
  });
  it("appends below a user-edited draft and locates the appended statement", () => {
    const draft = "SELECT name FROM berlin_cafes";
    const w = applyAutomatic(draft, seed, starterSql("districts"));
    expect(w.replaced).toBe(false);
    expect(w.text).toBe(draft + "\n\n" + starterSql("districts"));
    expect(w.text.slice(w.from, w.to)).toBe(starterSql("districts"));
    const w2 = applyAutomatic(draft + "\n", null, "SELECT 1");
    expect(w2.text).toBe(draft + "\n\nSELECT 1");
  });
  it("marks edited exactly when the draft differs from its seed", () => {
    expect(isEdited(seed, seed)).toBe(false);
    expect(isEdited(seed + " ", seed)).toBe(true);
    expect(isEdited("SELECT 1", null)).toBe(false);
    expect(isEdited("", seed)).toBe(false);
  });
  it("quotes identifiers the way the engine reads them back", () => {
    expect(quoteIdentifier("berlin_cafes")).toBe('"berlin_cafes"');
    expect(quoteIdentifier('odd"name')).toBe('"odd""name"');
  });
});

function entry(sql: string, at: string, ok = true, id = sql + at): HistoryEntry {
  return { id, sql, at, ok, rows: 1, ms: 1, code: ok ? null : "sql_error", tables: [] };
}

describe("history", () => {
  it("collapses identical SQL to the newest run and keeps the cap", () => {
    let list: HistoryEntry[] = [];
    list = addRun(list, entry("SELECT 1", "2026-08-23T10:00:00Z"));
    list = addRun(list, entry("SELECT 2", "2026-08-23T10:01:00Z"));
    list = addRun(list, entry(" SELECT 1 ", "2026-08-23T10:02:00Z", false));
    expect(list.map((h) => h.sql.trim())).toEqual(["SELECT 1", "SELECT 2"]);
    expect(list[0].ok).toBe(false);
    for (let i = 0; i < HISTORY_CAP + 5; i++) list = addRun(list, entry(`SELECT ${i + 10}`, "2026-08-23T11:00:00Z"));
    expect(list).toHaveLength(HISTORY_CAP);
    expect(list[0].sql).toBe(`SELECT ${HISTORY_CAP + 14}`);
  });
  it("removes by id, titles by tables, clamps long SQL", () => {
    const list = addRun([], entry("SELECT 1", "2026-08-23T10:00:00Z"));
    expect(removeRun(list, list[0].id)).toEqual([]);
    expect(titleOf({ tables: [] })).toBe("Query");
    expect(titleOf({ tables: ["a", "b", "c", "d"] })).toBe("a + b + 2 more");
    expect(isLong("SELECT 1")).toBe(false);
    expect(isLong("a\nb\nc\nd")).toBe(true);
    expect(isLong("x".repeat(151))).toBe(true);
  });
  it("groups by day against an injectable clock", () => {
    const now = new Date("2026-08-23T12:00:00");
    const list = [
      entry("SELECT 3", "2026-08-23T09:00:00"),
      entry("SELECT 2", "2026-08-22T09:00:00"),
      entry("SELECT 1", "2026-08-20T09:00:00"),
    ];
    expect(groupByDay(list, now).map((g) => [g.label, g.entries.length])).toEqual([
      ["Today", 1],
      ["Yesterday", 1],
      ["2026-08-20", 1],
    ]);
  });
});

describe("snippets", () => {
  it("fills the table and its geometry column, keeps other placeholders", () => {
    const s = SNIPPETS.find((x) => x.id === "count-by-area")!;
    const text = renderSnippet(s, { table: "berlin_cafes", geometryColumn: "geometry" });
    expect(text).toContain("JOIN berlin_cafes p ON ST_Within(p.geometry, a.<areas_geometry>)");
    expect(text).toContain("<areas_table>");
    const bare = renderSnippet(s, { table: null, geometryColumn: null });
    expect(bare).toContain("<your_table>");
    expect(bare).toContain("<geometry_column>");
    expect(bare).not.toMatch(/\bgeom\b/);
  });
  it("every function a snippet uses is in the completion list", () => {
    const used = new Set<string>();
    for (const s of SNIPPETS) {
      for (const m of s.template.matchAll(/\b(ST_\w+)\s*\(/g)) used.add(m[1]);
    }
    for (const f of used) expect(SPATIAL_FUNCTIONS).toContain(f);
    expect(SNIPPETS).toHaveLength(5);
  });
});

describe("table search", () => {
  const t = (name: string): TableListing => ({ name, qualifiedName: name } as unknown as TableListing);
  const tables = [t("berlin_cafes"), t("districts"), t("routes")];
  const cols = (n: string) => (n === "berlin_cafes" ? ["id", "name", "rating"] : n === "districts" ? ["id", "name"] : null);
  it("matches by name, then by column, naming the column", () => {
    expect(matchTables(tables, "", cols)).toHaveLength(3);
    expect(matchTables(tables, "dist", cols).map((m) => m.table.name)).toEqual(["districts"]);
    expect(matchTables(tables, "rating", cols)).toEqual([{ table: tables[0], column: "rating" }]);
    // an unread table matches by name only
    expect(matchTables(tables, "anything", cols)).toEqual([]);
  });
});

describe("stored history is validated", () => {
  it("drops a non-array and malformed entries, keeps well-formed ones", async () => {
    const { validateHistory } = await import("./sql-history");
    expect(validateHistory(null)).toEqual([]);
    expect(validateHistory({ sql: "x" })).toEqual([]);
    const good = { id: "a", sql: "SELECT 1", at: "2026-08-23T10:00:00Z", ok: true, rows: 1, ms: 2, code: null, tables: ["t"] };
    expect(validateHistory([good, { id: "b", sql: "SELECT 2" }, 3, null])).toEqual([good]);
  });
  it("snippets quote a geometry column or table that needs it", async () => {
    const { SNIPPETS, renderSnippet } = await import("./sql-snippets");
    const { identifierFor } = await import("./sql-draft");
    expect(identifierFor("geom")).toBe("geom");
    expect(identifierFor("Shape Geometry")).toBe('"Shape Geometry"');
    expect(identifierFor("1st")).toBe('"1st"');
    // Reserved words are quoted too: a column named select,
    // a table named order.
    expect(identifierFor("select")).toBe('"select"');
    expect(starterSql("order")).toBe('SELECT *\nFROM "order"\nLIMIT 100;');
    expect(starterSql("berlin_cafes")).toBe("SELECT *\nFROM berlin_cafes\nLIMIT 100;");
    const s = SNIPPETS.find((x) => x.id === "buffer")!;
    expect(renderSnippet(s, { table: "My Table", geometryColumn: "Geo Col" })).toContain('ST_Buffer("Geo Col", 0.002) AS "Geo Col"\nFROM "My Table"');
  });
});
