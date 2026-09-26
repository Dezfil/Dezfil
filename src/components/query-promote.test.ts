import { describe, expect, it } from "vitest";
import type { QueryResult } from "./query-types";
import { draftDiverged, resultIsMappable } from "./query-promote";

const result = (columns: { name: string; type: string }[]): QueryResult => ({
  columns,
  rowCount: 1,
  preview: [],
  previewTruncated: false,
  runtimeMs: 1,
});

describe("resultIsMappable", () => {
  it("arms on a plain geometry column", () => {
    expect(
      resultIsMappable(
        result([
          { name: "id", type: "BIGINT" },
          { name: "geom", type: "GEOMETRY" },
        ]),
      ),
    ).toBe(true);
  });

  it("arms on a CRS-typed geometry column", () => {
    expect(
      resultIsMappable(result([{ name: "geom", type: "GEOMETRY('EPSG:4326')" }])),
    ).toBe(true);
  });

  it("stays disarmed without geometry", () => {
    expect(
      resultIsMappable(
        result([
          { name: "x", type: "BIGINT" },
          { name: "wkt", type: "VARCHAR" },
        ]),
      ),
    ).toBe(false);
  });
});

describe("draftDiverged", () => {
  it("is calm while the draft matches the executed SQL", () => {
    expect(draftDiverged("SELECT 1", "SELECT 1")).toBe(false);
  });

  it("ignores whitespace-only edits — the executed SQL was trimmed", () => {
    expect(draftDiverged("SELECT 1", "  SELECT 1\n\n")).toBe(false);
  });

  it("flags a real edit", () => {
    expect(draftDiverged("SELECT 1", "SELECT 2")).toBe(true);
  });
});
