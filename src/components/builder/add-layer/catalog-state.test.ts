import { describe, it, expect } from "vitest";
import type { TableListing } from "../../api";
import type { QueryResult } from "../../query-types";
import {
  IDLE_PREVIEW,
  beginPreview,
  filterTables,
  followName,
  followSeed,
  impliedQuery,
  previewCurrency,
  settlePreview,
} from "./catalog-state";

const listing = (name: string) => ({ name }) as TableListing;
const someResult = { columns: [], rows: [] } as unknown as QueryResult;

describe("filterTables", () => {
  const tables = ["wind_farms", "Grid_Connections", "parcels_2024"].map(
    listing,
  );

  it("matches case-insensitive substrings and keeps server order", () => {
    expect(filterTables(tables, "GRID").map((t) => t.name)).toEqual([
      "Grid_Connections",
    ]);
    expect(filterTables(tables, "ar").map((t) => t.name)).toEqual([
      "wind_farms",
      "parcels_2024",
    ]);
  });

  it("returns the untouched list for a blank query", () => {
    expect(filterTables(tables, "  ")).toEqual(tables);
  });
});

describe("followName", () => {
  it("fills a blank field from the pick", () => {
    expect(followName("", null, "wind_farms")).toBe("wind_farms");
  });

  it("re-follows while still the previous automatic value", () => {
    expect(followName("wind_farms", "wind_farms", "ports_eu")).toBe(
      "ports_eu",
    );
  });

  it("never overwrites a user-edited name", () => {
    expect(followName("My layer", "wind_farms", "ports_eu")).toBe("My layer");
  });
});

describe("impliedQuery", () => {
  it("writes a pick as the engine reads it back, quoting a keyword part", () => {
    expect(impliedQuery("bo.stations")).toBe("SELECT * FROM bo.stations");
    expect(impliedQuery("group.stations")).toBe('SELECT * FROM "group".stations');
    expect(impliedQuery("asof.order")).toBe('SELECT * FROM "asof"."order"');
  });
});

describe("followSeed", () => {
  it("seeds an empty draft with the implied query", () => {
    expect(followSeed("", null, "wind_farms")).toBe(
      impliedQuery("wind_farms"),
    );
  });

  it("replaces a previous automatic seed on a re-pick", () => {
    expect(
      followSeed(impliedQuery("wind_farms"), impliedQuery("wind_farms"), "x"),
    ).toBe(impliedQuery("x"));
  });

  it("never replaces the user's own SQL, and no-ops without a pick", () => {
    expect(followSeed("SELECT 1", null, "wind_farms")).toBe("SELECT 1");
    expect(followSeed("", null, null)).toBe("");
  });
});

describe("preview fencing", () => {
  it("drops a slower superseded response whole", () => {
    const [s1, seqA] = beginPreview(IDLE_PREVIEW);
    const [s2, seqB] = beginPreview(s1); // second run issued before A lands
    const afterB = settlePreview(s2, {
      seq: seqB,
      sql: "SELECT 2",
      result: someResult,
      error: null,
      ms: 5,
    });
    const afterLateA = settlePreview(afterB, {
      seq: seqA,
      sql: "SELECT 1",
      result: someResult,
      error: null,
      ms: 50,
    });
    expect(afterLateA.settled?.sql).toBe("SELECT 2");
    expect(afterLateA.running).toBe(false);
  });

  it("marks a settled result stale once the draft diverges", () => {
    const [s1, seq] = beginPreview(IDLE_PREVIEW);
    const settled = settlePreview(s1, {
      seq,
      sql: "SELECT a FROM t",
      result: someResult,
      error: null,
      ms: 8,
    });
    expect(previewCurrency(settled, "SELECT a FROM t")).toBe("current");
    expect(previewCurrency(settled, "SELECT a, b FROM t")).toBe("stale");
  });

  it("reports none before any settle, and keeps errors current", () => {
    expect(previewCurrency(IDLE_PREVIEW, "")).toBe("none");
    const [s1, seq] = beginPreview(IDLE_PREVIEW);
    const failed = settlePreview(s1, {
      seq,
      sql: "SELECT nope",
      result: null,
      error: "Binder Error",
      ms: null,
    });
    expect(previewCurrency(failed, "SELECT nope")).toBe("current");
  });
});
