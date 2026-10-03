import { describe, expect, it } from "vitest";
import { affordableReach, roomForCard } from "./affordable-reach";

// The header row at 1280 with the builder's chrome: the card at the
// gutter, the search control and the actions beside it, one gap each.
const row = { cardLeft: 14, contentRight: 1264, gap: 14, siblingWidths: [220, 428] };

describe("the reach the header card can afford", () => {
  it("is the pane's reach while the row can pay for it", () => {
    expect(roomForCard(row)).toBe(1264 - 14 - 220 - 428 - 28);
    expect(affordableReach(424, row)).toBe(410);
  });

  it("is the room, not the reach, once the actions would leave the row", () => {
    // The workflow canvas in a 600 px window: no search control, the
    // history pair, the theme toggle and Run all beside the card.
    const narrow = { cardLeft: 14, contentRight: 584, gap: 14, siblingWidths: [254] };
    expect(roomForCard(narrow)).toBe(302);
    expect(affordableReach(424, narrow)).toBe(302);
  });

  it("follows the actions as they grow, and never goes below zero", () => {
    const withStatus = { ...row, siblingWidths: [220, 428 + 300] };
    expect(affordableReach(424, withStatus)).toBe(1264 - 14 - 220 - 728 - 28);
    const impossible = { ...row, siblingWidths: [1300] };
    expect(affordableReach(424, impossible)).toBe(0);
  });

  it("preserves fractional pane edges and never rounds beyond the available room", () => {
    expect(affordableReach(424.375, { ...row, cardLeft: 14.125 })).toBe(410.25);
    const narrow = { cardLeft: 14, contentRight: 464, gap: 14, siblingWidths: [123.375] };
    expect(affordableReach(424, narrow)).toBe(312.625);
    expect(affordableReach(424, narrow)).toBeLessThanOrEqual(roomForCard(narrow));
  });
});
