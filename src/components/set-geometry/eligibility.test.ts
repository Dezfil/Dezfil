import { describe, expect, it } from "vitest";
import type { TableSource } from "@/lib/metadata/tables";
import { canSetGeometry } from "./eligibility";

describe("where the doors appear (default 8)", () => {
  it("file uploads and URL imports only; every other source shows the surface as shipped", () => {
    const sources: [TableSource, boolean][] = [["upload", true], ["url", true], ["operation", false], ["sketch", false], ["postgis", false], ["osm", false], ["overture", false]];
    for (const [source, expected] of sources) expect(canSetGeometry({ source }), source).toBe(expected);
  });
});
