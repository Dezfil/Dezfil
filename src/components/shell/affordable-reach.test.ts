import { describe, expect, it } from "vitest";
import { affordableReach, roomForCard, shareOut } from "./affordable-reach";

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

  it("counts what the yielding search field can give, so it narrows for the reach before the card gives any up", () => {
    // The builder at 1440 with the rail standing open: the inspector's right
    // edge at 580; the search field (230 at rest, 150 at the least), the
    // last-changed fact and the actions beside the card.
    const open = { cardLeft: 14, contentRight: 1424, gap: 14, siblingWidths: [230, 113, 515] };
    expect(roomForCard(open)).toBe(510);
    // Without anything that yields the card stops 56 px short of the inspector.
    expect(affordableReach(580, open)).toBe(510);
    const yielding = { ...open, give: 80 };
    expect(affordableReach(580, yielding)).toBe(566);
    // The field gives exactly the shortfall, and nothing while the row has room.
    expect(shareOut(566, yielding, [{ width: 230, least: 150 }])).toEqual([56]);
    expect(shareOut(500, yielding, [{ width: 230, least: 150 }])).toEqual([0]);
    // Past what it can give, the card gives up the rest of its reach.
    expect(affordableReach(700, yielding)).toBe(590);
    expect(shareOut(590, yielding, [{ width: 230, least: 150 }])).toEqual([80]);
    // Several give in row order, each down to its least before the next.
    expect(shareOut(595, { ...open, give: 90 }, [{ width: 230, least: 150 }, { width: 100, least: 90 }])).toEqual([80, 5]);
  });
});
