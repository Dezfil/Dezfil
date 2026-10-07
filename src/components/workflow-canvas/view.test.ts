import { describe, expect, it } from "vitest";
import { fitOptions } from "./view";

/** The fit's padding (reference 13; adds the helper's
 * right): what the pane takes when it overlays, and what a shifted panel
 * moved by, keep the fit out from under both. */
describe("fitOptions", () => {
  it("keeps the reference's insets: 56 all round framed; the pane's free area and the band's reserve in full view", () => {
    expect(fitOptions("framed").padding).toEqual({ top: "56px", right: "56px", bottom: "56px", left: "56px" });
    expect(fitOptions("full", false, 120).padding).toEqual({ top: "76px", right: "56px", bottom: "176px", left: "494px" });
  });
  it("keeps the full view's first column clear of a pane the always-open rail moved right", () => {
    expect(fitOptions("full", false, 0, 0, 156).padding).toMatchObject({ left: "650px" });
    // The framed view's canvas card moves with the pane: its insets are its own.
    expect(fitOptions("framed", false, 0, 0, 156).padding).toMatchObject({ left: "56px" });
  });
  it("an open panel takes the right edge; the helper's right adds to it", () => {
    expect(fitOptions("full", true).padding).toMatchObject({ right: "386px" });
    expect(fitOptions("full", false, 0, 354).padding).toMatchObject({ right: "410px" });
    expect(fitOptions("full", true, 0, 354).padding).toMatchObject({ right: "740px" });
    expect(fitOptions("framed", true, 0, 354).padding).toMatchObject({ right: "740px" });
  });
});
