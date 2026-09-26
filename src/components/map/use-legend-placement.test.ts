import { describe, expect, it } from "vitest";
import {
  bottomRightRoom,
  legendPlacement,
} from "./use-legend-placement";

describe("legendPlacement", () => {
  it("defaults an unmeasured bottom-right legend to a safe rail dock", () => {
    expect(legendPlacement("bottom-right", true)).toEqual({
      docked: true,
      width: "rail",
      measured: false,
    });
  });

  it("keeps bottom-right standalone when its measured band has room", () => {
    expect(legendPlacement("bottom-right", true, true)).toEqual({
      docked: false,
      width: "fit",
      measured: true,
    });
  });

  it("docks bottom-right at rail width when the measured band is crowded", () => {
    expect(legendPlacement("bottom-right", true, false)).toEqual({
      docked: true,
      width: "rail",
      measured: true,
    });
  });

  it("leaves every corner standalone when there are no widgets", () => {
    for (const corner of [
      "top-left",
      "top-right",
      "bottom-left",
      "bottom-right",
    ] as const) {
      expect(legendPlacement(corner, false)).toEqual({
        docked: false,
        width: "fit",
        measured: true,
      });
    }
  });

  it("always docks top-right into the full-width rail context", () => {
    expect(legendPlacement("top-right", true)).toEqual({
      docked: true,
      width: "rail",
      measured: true,
    });
  });
});

describe("bottomRightRoom", () => {
  it("uses the standalone candidate's live height and the rail gap", () => {
    expect(bottomRightRoom({ bottom: 240 }, { top: 260 }, 10)).toBe(true);
    expect(bottomRightRoom({ bottom: 251 }, { top: 260 }, 10)).toBe(false);
  });
});
