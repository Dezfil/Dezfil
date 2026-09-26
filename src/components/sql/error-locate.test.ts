import { describe, expect, it } from "vitest";
import { locateNamed, namedIdentifier } from "./error-locate";

describe("the identifier fallback for the error mark", () => {
  it("reads the named identifier out of the engine's wording", () => {
    expect(namedIdentifier("Catalog Error: Table with name nope does not exist!")).toBe("nope");
    expect(namedIdentifier('Binder Error: Referenced column "ratng" not found in FROM clause!')).toBe("ratng");
    expect(namedIdentifier('Parser Error: syntax error at or near "stations"')).toBe("stations");
    expect(namedIdentifier("Catalog Error: Scalar Function with name st_buffe does not exist!")).toBe("st_buffe");
    expect(namedIdentifier("Out of Memory Error")).toBeNull();
  });
  it("locates a unique occurrence, case-insensitively, as a whole word", () => {
    expect(locateNamed("SELECT *\nFROM nope", "Table with name nope does not exist!")).toEqual({ line: 2, column: 6 });
    expect(locateNamed("SELECT ratng, rating FROM t", 'Referenced column "ratng" not found')).toEqual({ line: 1, column: 8 });
    expect(locateNamed("SELECT * FROM Stations", 'syntax error at or near "stations"')).toEqual({ line: 1, column: 15 });
  });
  it("refuses an ambiguous or absent identifier", () => {
    expect(locateNamed("SELECT nope FROM nope", "Table with name nope does not exist!")).toBeNull();
    expect(locateNamed("SELECT 1", "Table with name nope does not exist!")).toBeNull();
    expect(locateNamed("SELECT nope_x FROM t", "Table with name nope does not exist!")).toBeNull();
  });
});
