import { describe, it, expect } from "vitest";
import {
  aggregateLevels,
  searchIndex,
  subtypeLabel,
  subtypeOrder,
  CITY_SCOPE_SUBTYPES,
  CITY_SEARCH_SUBTYPES,
  type DivisionIndexRow,
} from "./divisions";
import type { Bbox } from "@/lib/bbox";

const box: Bbox = [8, 50, 9, 51];

function row(
  name: string,
  subtype: string,
  region: string | null = "DE-HE",
): DivisionIndexRow {
  return { divisionId: `id-${name}`, name, subtype, region, bbox: box };
}

describe("level aggregation", () => {
  it("counts per subtype, coarse to fine, with up to three samples", () => {
    const rows = [
      row("Gallus", "macrohood"),
      row("Deutschland", "country", null),
      row("Hessen", "region"),
      row("Westend", "macrohood"),
      row("Niederrad", "macrohood"),
      row("Höchst", "macrohood"),
      row("Bayern", "region"),
    ];
    const levels = aggregateLevels(rows);
    expect(levels.map((l) => l.subtype)).toEqual([
      "country",
      "region",
      "macrohood",
    ]);
    const macro = levels[2];
    expect(macro.count).toBe(4);
    expect(macro.samples).toHaveLength(3);
    expect(macro.label).toBe("City districts");
  });

  it("labels unknown subtypes without dropping them", () => {
    const levels = aggregateLevels([row("X", "exclave")]);
    expect(levels[0].label).toBe("Exclave");
    expect(subtypeOrder("exclave")).toBeGreaterThan(subtypeOrder("microhood"));
  });
});

describe("name search", () => {
  const rows = [
    row("Frankfurt am Main", "county"),
    row("Frankfurt (Oder)", "locality", "DE-BB"),
    row("Frankfurter Berg", "neighborhood"),
    row("Eschborn", "locality"),
    row("Offenbach am Main", "county"),
  ];

  it("matches city-scope subtypes only, prefix before substring", () => {
    const matches = searchIndex(rows, "frank");
    expect(matches.map((m) => m.name)).toEqual([
      "Frankfurt (Oder)",
      "Frankfurt am Main",
    ]);
    // The neighborhood is not a scope; the substring match ranks last.
    const am = searchIndex(rows, "am main");
    expect(am.map((m) => m.name)).toEqual([
      "Frankfurt am Main",
      "Offenbach am Main",
    ]);
  });

  it("carries the friendly kind label and region for disambiguation", () => {
    const [first] = searchIndex(rows, "frankfurt am");
    expect(first.label).toBe(subtypeLabel("county"));
    expect(first.region).toBe("DE-HE");
  });

  it("returns nothing for a blank query", () => {
    expect(searchIndex(rows, "  ")).toEqual([]);
  });

  it("kreisfreie Städte are reachable as cities", () => {
    expect(CITY_SCOPE_SUBTYPES).toContain("county");
  });

  it("city-states are searchable and an exact prefix ranks first", () => {
    expect(CITY_SEARCH_SUBTYPES).toContain("region");
    const withBerlin = [
      row("Berlingen", "locality", "DE-RP"),
      row("Berlin", "region", "DE-BE"),
      row("Rüdersdorf bei Berlin", "locality", "DE-BB"),
      row("Berlinchen", "locality", "DE-BB"),
    ];
    const matches = searchIndex(withBerlin, "Berlin");
    expect(matches[0].name).toBe("Berlin");
    expect(matches[0].label).toBe(subtypeLabel("region"));
    expect(matches.map((m) => m.name)).toContain("Rüdersdorf bei Berlin");
  });
});
