import { describe, expect, it } from "vitest";
import { canvasHelperLayout, fitHelper } from "./assistant-layout";

/** Item 7's decisions at the spec's widths; the rectangles are the
 * browser suite's. */
describe("the canvas's helper layout", () => {
  it("framed at 1440 (one docked): the pane docks and hides an open panel; the selection is the caller's to keep", () => {
    expect(canvasHelperLayout({ view: "framed", band: "one", paneOpen: true, panelUp: true })).toEqual({ paneOverlay: false, hostRight: 354, panelHidden: true, panelShift: 0, bandRight: 0 });
    expect(canvasHelperLayout({ view: "framed", band: "one", paneOpen: true, panelUp: false }).panelHidden).toBe(false);
  });
  it("framed at 1920 (both): the host gives up the width and the panel stays inside the card", () => {
    expect(canvasHelperLayout({ view: "framed", band: "both", paneOpen: true, panelUp: true })).toEqual({ paneOverlay: false, hostRight: 354, panelHidden: false, panelShift: 0, bandRight: 0 });
  });
  it("framed at 1100 (overlay): the host is unmoved and the pane lies over it", () => {
    expect(canvasHelperLayout({ view: "framed", band: "overlay", paneOpen: true, panelUp: true })).toEqual({ paneOverlay: true, hostRight: 0, panelHidden: true, panelShift: 0, bandRight: 0 });
  });
  it("full at 1920: the panel shifts left by the pane and both stay (B); full at 1440 and 1000: the panel hides", () => {
    expect(canvasHelperLayout({ view: "full", band: "both", paneOpen: true, panelUp: true })).toEqual({ paneOverlay: true, hostRight: 0, panelHidden: false, panelShift: 354, bandRight: 354 });
    expect(canvasHelperLayout({ view: "full", band: "one", paneOpen: true, panelUp: true }).panelHidden).toBe(true);
    expect(canvasHelperLayout({ view: "full", band: "overlay", paneOpen: true, panelUp: true }).panelHidden).toBe(true);
  });
  it("full view at every width: the band gives up the pane's width plus the helper gutter, 354, so its right edge stops 12 px short of the pane's left", () => {
    // Seeded defect on the shipped tree: the band gave up the width alone,
    // 342, and its border met the pane's. The literal 354 is the expectation,
    // written here, not the constant the layout reads.
    for (const band of ["overlay", "one", "both"] as const) expect(canvasHelperLayout({ view: "full", band, paneOpen: true, panelUp: false }).bandRight).toBe(354);
  });
  it("with the pane closed nothing moves or hides, whatever the view", () => {
    for (const view of ["full", "framed"] as const) for (const band of ["overlay", "one", "both"] as const) {
      const l = canvasHelperLayout({ view, band, paneOpen: false, panelUp: true });
      expect([l.hostRight, l.panelHidden, l.panelShift, l.bandRight]).toEqual([0, false, 0, 0]);
    }
  });
});

describe("what the fits read on the right", () => {
  it("counts a hidden panel as none and the assistant once: 1000 full with a member and the pane, 1920 full with the panel shifted", () => {
    const at1000 = canvasHelperLayout({ view: "full", band: "overlay", paneOpen: true, panelUp: true });
    expect(fitHelper(at1000, true, true), "a hidden panel adds no inset; the overlaying pane adds its width plus gutter once").toEqual({ panel: false, helperRight: 354 });
    const at1920 = canvasHelperLayout({ view: "full", band: "both", paneOpen: true, panelUp: true });
    expect(fitHelper(at1920, true, true), "a visible shifted panel adds its inset plus the shift; the pane behind it is not counted again").toEqual({ panel: true, helperRight: 354 });
    const framedDocked = canvasHelperLayout({ view: "framed", band: "both", paneOpen: true, panelUp: true });
    expect(fitHelper(framedDocked, true, true)).toEqual({ panel: true, helperRight: 0 });
    const closed = canvasHelperLayout({ view: "full", band: "one", paneOpen: false, panelUp: true });
    expect(fitHelper(closed, false, true)).toEqual({ panel: true, helperRight: 0 });
  });
});
