import { describe, expect, it } from "vitest";
import { PANE_MIN, shownSidebarWidth, sidebarAvailable, sidebarBound } from "./use-console-splits";

/** The sidebar's bound under a docked pane, and its clamp: the
 * arithmetic; the rectangles are the browser suite's. */
describe("the sidebar's bound", () => {
  it("is half the window with no docked pane, as before", () => {
    expect(sidebarAvailable(1440, false)).toBe(1440);
    expect(sidebarBound(1440, false)).toBe(720);
    expect(sidebarBound(1121, false)).toBe(560);
  });
  it("is half of what a docked pane leaves: the window less the rail, the pane with its gutter and the right gutter", () => {
    expect(sidebarAvailable(1121, true)).toBe(1121 - 82 - 354 - 14);
    expect(sidebarBound(1121, true)).toBe(335);
    expect(sidebarBound(1440, true)).toBe(495);
  });
  it("gives up what the always-open rail adds beside a docked pane", () => {
    expect(sidebarAvailable(1440, true, 156)).toBe(1440 - 82 - 156 - 354 - 14);
    expect(sidebarBound(1440, true, 156)).toBe(417);
    // With no docked pane the bound is half the window, rail or not.
    expect(sidebarAvailable(1440, false, 156)).toBe(1440);
  });
  it("never drops under the sidebar's minimum", () => {
    expect(sidebarBound(600, true)).toBe(PANE_MIN);
  });
  it("shows the remembered width until the bound, and the bound beyond it", () => {
    expect(shownSidebarWidth(560, 1121, true)).toBe(335);
    // At 1121 the bound (335) sits under the default 342: the default clamps too.
    expect(shownSidebarWidth(342, 1121, true)).toBe(335);
    expect(shownSidebarWidth(342, 1440, true)).toBe(342);
    expect(shownSidebarWidth(560, 1121, false)).toBe(560);
  });
});
