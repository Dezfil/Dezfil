import { describe, expect, it } from "vitest";
import { MENU_GAP, MENU_INSET, menuRoom } from "./menu-room";

/**
 * The ceiling the picker's menu takes inside the pane (the effort rows
 * fix). The rule is pure; which rectangles feed it is the
 * browser pass's to confirm.
 */
describe("the room the menu has above the chip", () => {
  it("is the distance to the pane's top, less the float gap and the border inset", () => {
    expect(menuRoom(62, 500)).toBe(500 - 62 - MENU_GAP - MENU_INSET);
    // A subpixel anchor rounds down, so the ceiling never exceeds the room.
    expect(menuRoom(62, 500.7)).toBe(500 - 62 - MENU_GAP - MENU_INSET);
  });

  it("never goes negative when the chip sits at the pane's top", () => {
    expect(menuRoom(62, 62)).toBe(0);
    expect(menuRoom(62, 70)).toBe(0);
  });
});
