import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PreviewRefusalPlate } from "./PreviewRefusalPlate";

describe("the preview map's refusal plate (the door)", () => {
  it("states the API's sentence with a mark, and carries the Set geometry door only when the page hands one in", () => {
    const bare = renderToStaticMarkup(<PreviewRefusalPlate reason="This table has no geometry column." />);
    expect(bare).toContain("data-preview-refusal");
    expect(bare).toContain("<span>This table has no geometry column.</span>");
    expect(bare).not.toContain("Set geometry");
    const door = renderToStaticMarkup(<PreviewRefusalPlate reason="This table has no geometry column." onSetGeometry={() => {}} />);
    expect(door).toMatch(/<button[^>]*data-set-geometry-door="plate"[^>]*><svg.*?<\/svg>Set geometry<\/button>/);
  });
});
