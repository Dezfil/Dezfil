import { describe, it, expect } from "vitest";
import { rewriteTableReferences, tableReferences } from "./sql-references";

const names = (sql: string) => tableReferences(sql).map((r) => r.name);

describe("table references in SQL text", () => {
  it("finds FROM, every JOIN kind, and the members of a FROM list", () => {
    expect(names("SELECT * FROM stations")).toEqual(["stations"]);
    expect(names("select s.* from stations s left join districts d on st_within(s.geom, d.geom)")).toEqual(["stations", "districts"]);
    expect(names("SELECT * FROM a, b AS bb, c WHERE a.id = b.id")).toEqual(["a", "b", "c"]);
    expect(names("SELECT * FROM a CROSS JOIN b NATURAL JOIN c")).toEqual(["a", "b", "c"]);
  });

  it("takes the table from a qualified name and keeps a quoted one quoted", () => {
    const refs = tableReferences('SELECT * FROM main.stations JOIN "Cafés 500m" c ON true');
    expect(refs.map((r) => [r.name, r.form])).toEqual([["stations", "bare"], ["Cafés 500m", "quoted"]]);
    // The span covers the quotes, so a rewrite replaces the whole token.
    const sql = 'SELECT * FROM main.stations JOIN "Cafés 500m" c ON true';
    expect(sql.slice(refs[1].start, refs[1].end)).toBe('"Cafés 500m"');
    expect(sql.slice(refs[0].start, refs[0].end)).toBe("stations");
  });

  it("leaves literals, comments, table functions, subqueries, aliases and columns alone", () => {
    const sql = [
      "-- from stations, the comment",
      "SELECT name, 'from stations' AS note, /* from districts */ count(*) AS stations",
      "FROM read_parquet('stations.parquet') p",
      "JOIN (SELECT * FROM cafes) c ON c.id = p.id",
      "WHERE note <> 'from cafes'",
    ].join("\n");
    expect(names(sql)).toEqual(["cafes"]);
  });

  it("does not treat a WITH clause's names as tables, but does the tables it reads", () => {
    const sql = "WITH near AS (SELECT * FROM stations WHERE d < 500), far AS (SELECT * FROM stations WHERE d >= 500) SELECT * FROM near JOIN far ON near.id = far.id";
    expect(names(sql)).toEqual(["stations", "stations"]);
  });

  it("rewrites only the references, keeping every other character, and only the names asked for", () => {
    const sql = "SELECT 'stations' AS label -- stations\nFROM stations s JOIN districts d ON s.d = d.id WHERE d.name <> 'stations'";
    const out = rewriteTableReferences(sql, (n) => (n === "stations" ? "stations_copy" : null));
    expect(out).toBe("SELECT 'stations' AS label -- stations\nFROM stations_copy s JOIN districts d ON s.d = d.id WHERE d.name <> 'stations'");
    expect(rewriteTableReferences('SELECT * FROM "Stations"', (n) => (n === "stations" ? "stations_copy" : null))).toBe('SELECT * FROM "stations_copy"');
    expect(rewriteTableReferences(sql, () => null)).toBe(sql);
  });

  it("rewrites every occurrence of a repeated reference", () => {
    const sql = "SELECT * FROM a UNION ALL SELECT * FROM a JOIN a AS again ON true";
    expect(rewriteTableReferences(sql, (n) => (n === "a" ? "a_copy" : null))).toBe(
      "SELECT * FROM a_copy UNION ALL SELECT * FROM a_copy JOIN a_copy AS again ON true",
    );
  });
});

describe("what the review found", () => {
  it("a comma inside an alias's column list is not a table separator", () => {
    const sql = "SELECT old FROM external AS e(foo, old) JOIN old AS o ON o.id = e.foo";
    expect(names(sql)).toEqual(["external", "old"]);
    expect(rewriteTableReferences(sql, (n) => (n === "old" ? "old_copy" : null))).toBe(
      "SELECT old FROM external AS e(foo, old) JOIN old_copy AS o ON o.id = e.foo",
    );
    expect(names("SELECT * FROM a, b AS bb(x, y), c")).toEqual(["a", "b", "c"]);
  });

  it("rewrites the dynamic reads the engine knows as tables: query_table and query", () => {
    const sql = "SELECT * FROM query_table('upstream') u JOIN query('SELECT * FROM upstream WHERE x = ''upstream''') q ON true";
    expect(tableReferences(sql).map((r) => [r.name, r.form])).toEqual([["upstream", "string"]]);
    expect(rewriteTableReferences(sql, (n) => (n === "upstream" ? "upstream_copy" : null))).toBe(
      "SELECT * FROM query_table('upstream_copy') u JOIN query('SELECT * FROM upstream_copy WHERE x = ''upstream''') q ON true",
    );
    // A table function that is not one of the two is left alone, argument and all.
    expect(names("SELECT * FROM read_csv('upstream.csv')")).toEqual([]);
  });

  it("a non-recursive CTE's own body reads the base table of the same name; the rest of the statement reads the CTE", () => {
    const sql = "WITH upstream AS (SELECT * FROM upstream WHERE d < 5) SELECT * FROM upstream";
    expect(names(sql)).toEqual(["upstream"]);
    expect(rewriteTableReferences(sql, (n) => (n === "upstream" ? "upstream_copy" : null))).toBe(
      "WITH upstream AS (SELECT * FROM upstream_copy WHERE d < 5) SELECT * FROM upstream",
    );
    // Recursive: the name is the CTE inside its own body too.
    expect(names("WITH RECURSIVE t AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM t WHERE n < 3) SELECT * FROM t")).toEqual([]);
  });

  it("a FROM list resumes after a subquery member", () => {
    expect(names("SELECT * FROM (SELECT * FROM inner_t) s, outer_t o WHERE s.id = o.id")).toEqual(["inner_t", "outer_t"]);
  });
});

describe("a rename that keeps the name the query binds a table by", () => {
  const keep = (sql: string, to: Record<string, string>) =>
    rewriteTableReferences(sql, (n) => to[n] ?? null, { keepBoundName: true });

  it("gives a renamed table with no alias of its own its old name, as written, so its qualified columns still find it", () => {
    expect(keep("SELECT stations.geom FROM stations", { stations: "stations_2" })).toBe("SELECT stations.geom FROM stations_2 AS stations");
    expect(keep('SELECT "Stations".geom FROM "Stations" WHERE "Stations".riders > 1', { stations: "stations_2" }))
      .toBe('SELECT "Stations".geom FROM "stations_2" AS "Stations" WHERE "Stations".riders > 1');
    expect(keep("SELECT * FROM main.stations", { stations: "stations_2" })).toBe("SELECT * FROM main.stations_2 AS stations");
    expect(keep("SELECT s.geom, d.name FROM stations s JOIN districts ON true", { stations: "stations_2", districts: "districts_2" }))
      .toBe("SELECT s.geom, d.name FROM stations_2 s JOIN districts_2 AS districts ON true");
    expect(keep("FROM stations SELECT stations.id", { stations: "stations_2" })).toBe("FROM stations_2 AS stations SELECT stations.id");
  });

  it("leaves an alias of the table's own as it is, quoted or bare, and never adds a second", () => {
    for (const sql of [
      "SELECT s.* FROM stations s",
      "SELECT s.* FROM stations AS s",
      'SELECT "S".* FROM stations "S"',
      "SELECT s.* FROM stations AS s(a, b, c, d, e)",
    ]) expect(keep(sql, { stations: "stations_2" })).toBe(sql.replace("FROM stations", "FROM stations_2"));
  });

  it("reads a keyword after the name as the clause it opens, not an alias", () => {
    for (const tail of ["WHERE riders > 1", "TABLESAMPLE 10%", "USING SAMPLE 10%", "LEFT JOIN districts ON true", "ORDER BY 1", "LIMIT 3", "QUALIFY true", "WINDOW w AS ()"]) {
      expect(keep(`SELECT * FROM stations ${tail}`, { stations: "stations_2" })).toBe(`SELECT * FROM stations_2 AS stations ${tail}`);
    }
    expect(keep("SELECT * FROM (SELECT * FROM stations) t", { stations: "stations_2" })).toBe("SELECT * FROM (SELECT * FROM stations_2 AS stations) t");
    expect(keep("SELECT * FROM stations, districts", { stations: "stations_2" })).toBe("SELECT * FROM stations_2 AS stations, districts");
  });

  it("leaves a name that lands as itself, and a query_table string, exactly as written; a query string's own SQL keeps its names too", () => {
    expect(keep("SELECT stations.geom FROM stations", {})).toBe("SELECT stations.geom FROM stations");
    expect(keep("SELECT * FROM query_table('stations')", { stations: "stations_2" })).toBe("SELECT * FROM query_table('stations_2')");
    expect(keep("SELECT * FROM query('SELECT stations.id FROM stations')", { stations: "stations_2" }))
      .toBe("SELECT * FROM query('SELECT stations.id FROM stations_2 AS stations')");
  });

  it("without the option, renames as it always has", () => {
    expect(rewriteTableReferences("SELECT * FROM stations", (n) => (n === "stations" ? "stations_2" : null))).toBe("SELECT * FROM stations_2");
  });
});
