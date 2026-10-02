import { describe, expect, it } from "vitest";
import type { TableSource } from "@/lib/metadata/tables";
import { canSetGeometry } from "./eligibility";

describe("where the doors appear (default 8)", () => {
  it("file uploads and URL imports only; every other source shows the surface as shipped", () => {
    const sources: [TableSource, boolean][] = [["upload", true], ["url", true], ["operation", false], ["sketch", false], ["postgis", false], ["osm", false], ["overture", false]];
    for (const [source, expected] of sources) expect(canSetGeometry({ source }), source).toBe(expected);
  });

  it("only on the reader's own dataset: someone else's, typed `<sql name>.<name>`, shows no door", () => {
    for (const source of ["upload", "url"] as TableSource[]) {
      expect(canSetGeometry({ source, name: "roads", qualifiedName: "roads" }), `${source}, own`).toBe(true);
      expect(canSetGeometry({ source, name: "roads", qualifiedName: "ada.roads" }), `${source}, someone else's`).toBe(false);
    }
    expect(canSetGeometry({ source: "osm", name: "roads", qualifiedName: "roads" })).toBe(false);
  });
});
