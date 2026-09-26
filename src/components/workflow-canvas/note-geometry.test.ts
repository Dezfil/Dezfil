import { describe, it, expect } from "vitest";
import { NOTE_COLORS } from "@/lib/metadata/recipe-layouts";
import { centreOf, duplicateRect, NOTE_COLOR_NAMES, NOTE_DEFAULT, NOTE_MIN, rectAt, rectFromDrag, settleResize } from "./note-geometry";

describe("a note's measures", () => {
  it("names the six colours as the API does, in its order", () => {
    expect([...NOTE_COLOR_NAMES]).toEqual([...NOTE_COLORS]);
  });

  it("a click makes the default size centred on the point, on the grid", () => {
    expect(rectAt({ x: 500, y: 300 })).toEqual({ x: 344, y: 216, w: 320, h: 176 });
    expect(rectAt({ x: 503, y: 297 })).toEqual({ x: 344, y: 208, w: 320, h: 176 });
    expect(NOTE_DEFAULT).toEqual({ w: 320, h: 176 });
  });

  it("a drag makes a box between its corners whichever way it was drawn, never below the minimum", () => {
    expect(rectFromDrag({ x: 100, y: 100 }, { x: 420, y: 300 })).toEqual({ x: 104, y: 104, w: 320, h: 200 });
    expect(rectFromDrag({ x: 420, y: 300 }, { x: 100, y: 100 })).toEqual({ x: 104, y: 104, w: 320, h: 200 });
    expect(rectFromDrag({ x: 100, y: 100 }, { x: 130, y: 110 })).toEqual({ x: 104, y: 104, w: NOTE_MIN.w, h: NOTE_MIN.h });
    expect(rectFromDrag({ x: 101, y: 99 }, { x: 411, y: 305 })).toEqual({ x: 104, y: 96, w: 312, h: 208 });
  });

  it("a resize settles on the grid at or above the minimum against the note it started from: an unmoved axis keeps its position, a moved one its far edge", () => {
    // A north-west drag: both positions moved; the south-east corner stays.
    expect(settleResize({ x: 100, y: 100, w: 333, h: 181 }, { x: 133, y: 137, w: 300, h: 144 })).toEqual({ x: 97, y: 97, w: 336, h: 184 });
    // An east drag on a note stored off the grid: the width alone changes.
    expect(settleResize({ x: 101, y: 50, w: 333, h: 176 }, { x: 101, y: 50, w: 320, h: 176 })).toEqual({ x: 101, y: 50, w: 336, h: 176 });
    // Below the minimum, from the north-west: the south-east corner stays exactly.
    expect(settleResize({ x: 260, y: 200, w: 120, h: 60 }, { x: 180, y: 140, w: 200, h: 120 })).toEqual({ x: 180, y: 148, w: 200, h: 112 });
  });

  it("a duplicate sits 32 right and down; Enter's point is the area's centre", () => {
    expect(duplicateRect({ x: 8, y: 16, w: 320, h: 176 })).toEqual({ x: 40, y: 48, w: 320, h: 176 });
    expect(centreOf({ x: 452, y: 72, width: 600, height: 400 })).toEqual({ x: 752, y: 272 });
  });
});
