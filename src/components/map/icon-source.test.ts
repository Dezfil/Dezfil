import { describe, it, expect } from "vitest";
import { iconSource, svgAspect } from "./icon-source";

describe("icon source", () => {
  it("a glyph resolves to the bundled Maki URL at the declared raster", () => {
    expect(iconSource("cafe", null)).toEqual({
      url: "/maki/cafe.svg",
      width: 256,
      height: 256,
      mask: true,
    });
    expect(iconSource("cafe", undefined).url).toBe("/maki/cafe.svg");
  });

  it("custom markup wins as an encoded inline image, aspect preserved in bounds", () => {
    const wide =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 24"><path d="M0 0h48"/></svg>';
    const source = iconSource("cafe", wide);
    expect(source.url.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(
      true,
    );
    // The data URI carries injected natural dimensions — a viewBox-only
    // SVG cannot be bitmapped (the smoke's silent-blank defect) — while
    // the input markup itself is never resized.
    const carried = decodeURIComponent(source.url.split(",")[1]);
    expect(carried).toContain('width="512" height="256"');
    expect(carried).toContain('viewBox="0 0 48 24"');
    expect(source.width).toBe(512);
    expect(source.height).toBe(256);
    expect(source.mask).toBe(true);
    // Declared dimensions are REWRITTEN to the bounded box: a small declaration re-creates the 15px
    // blur and a giant one bypasses the raster bound — the URI root always carries the computed
    // box, exactly once per side, and the child content is untouched.
    const declared =
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M0 0"/></svg>';
    const rewritten = decodeURIComponent(
      iconSource("cafe", declared).url.split(",")[1],
    );
    expect(rewritten).toContain('width="256" height="256"');
    expect(rewritten).not.toContain('width="24"');
    expect(rewritten).toContain('<path d="M0 0"/>');
    const heightOnly =
      '<svg xmlns="http://www.w3.org/2000/svg" height="24" viewBox="0 0 8 8"><path d="M0 0h8"/></svg>';
    const oneSided = decodeURIComponent(
      iconSource("cafe", heightOnly).url.split(",")[1],
    );
    expect(oneSided.match(/height=/g)?.length).toBe(1);
    expect(oneSided.match(/width=/g)?.length).toBe(1);
    expect(oneSided).toContain('height="256"');
    // Extreme aspects clamp instead of collapsing or exploding.
    expect(
      iconSource("cafe", '<svg viewBox="0 0 1000 10"><path d="M0 0"/></svg>')
        .width,
    ).toBe(1024);
    expect(
      iconSource("cafe", '<svg viewBox="0 0 10 1000"><path d="M0 0"/></svg>')
        .width,
    ).toBe(64);
  });

  it("aspect falls back from viewBox to width/height to square", () => {
    expect(svgAspect('<svg viewBox="0 0 32 16"/>')).toBe(2);
    expect(svgAspect('<svg width="10" height="20"/>')).toBe(0.5);
    expect(svgAspect("<svg/>")).toBe(1);
    expect(svgAspect('<svg viewBox="0 0 0 0"/>')).toBe(1);
  });
});
