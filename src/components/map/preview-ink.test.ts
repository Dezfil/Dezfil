import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { previewInk } from "./preview-ink";

/**
 * The feature preview draws in the interface's ink, not a data colour:
 * the accent token, so the person's Color reaches it as it reaches every
 * other accent, and today's kelp before anything has computed.
 */
afterEach(() => vi.unstubAllGlobals());
const host = {} as Element;
function computed(accent: string) {
  vi.stubGlobal("window", { getComputedStyle: () => ({ getPropertyValue: (name: string) => (name === "--accent" ? accent : "") }) });
}

describe("the feature preview's ink", () => {
  it("is the accent token where the preview stands", () => {
    computed(" #2b62a6");
    expect(previewInk(host, "light")).toBe("#2b62a6");
    computed("#ab95ec");
    expect(previewInk(host, "dark")).toBe("#ab95ec");
  });

  it("is today's kelp before anything has computed", () => {
    computed("");
    expect(previewInk(host, "light")).toBe("#0d7d5c");
    expect(previewInk(null, "dark")).toBe("#45c58f");
  });

  it("is the only ink the preview map writes", () => {
    const source = readFileSync("src/components/map/FeaturePreviewMap.tsx", "utf8");
    expect(source).toMatch(/previewInk\(/);
    expect(source).not.toMatch(/#0d7d5c|#45c58f/i);
  });
});
