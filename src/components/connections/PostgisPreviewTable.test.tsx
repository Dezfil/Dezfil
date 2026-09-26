import { describe, expect, it } from "vitest";
import { previewCell } from "./PostgisPreviewTable";

describe("previewCell", () => {
  it("renders source values without inventing data", () => {
    expect(previewCell(null)).toBe("NULL");
    expect(previewCell(undefined)).toBe("NULL");
    expect(previewCell(false)).toBe("false");
    expect(previewCell(0)).toBe("0");
    expect(previewCell("Dezfil")).toBe("Dezfil");
    expect(previewCell({ type: "Point", coordinates: [7, 52] })).toBe(
      '{"type":"Point","coordinates":[7,52]}',
    );
    const byteString = "\\x01" + "ab".repeat(80);
    expect(previewCell(byteString)).toBe(`${byteString.slice(0, 120)}…`);
  });
});
