import { describe, it, expect } from "vitest";
import { ApiError } from "@/lib/api/errors";
import {
  sanitizeSvgIcon,
  ICON_SVG_BYTE_CAP,
} from "./icon-sanitize";

const CLEAN =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
  '<path d="M12 2L2 22h20z" fill="#000"/></svg>';

const message = (fn: () => unknown): string => {
  try {
    fn();
    return "";
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("invalid_request");
    return (error as ApiError).message;
  }
};

describe("icon sanitizer", () => {
  it("returns clean SVG byte-identically, unchanged and unreported", () => {
    const result = sanitizeSvgIcon(CLEAN);
    expect(result.svg).toBe(CLEAN);
    expect(result.changed).toBe(false);
    expect(result.dropped).toEqual([]);
    expect(result.aspect).toBe(1);
  });

  it("strips scripts, event handlers, and remote references — and reports each", () => {
    const hostile =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)">' +
      "<script>alert(2)</script>" +
      '<path d="M0 0h10" fill="url(#g)"/>' +
      '<image href="https://evil.test/x.png"/>' +
      "</svg>";
    const result = sanitizeSvgIcon(hostile);
    expect(result.changed).toBe(true);
    const names = result.dropped.map((d) => `${d.kind}:${d.name}`);
    expect(names).toContain("attribute:onload");
    expect(names).toContain("element:script");
    expect(names).toContain("attribute:fill"); // the url() value
    expect(names).toContain("element:image");
    expect(result.svg).not.toContain("script");
    expect(result.svg).not.toContain("onload");
    expect(result.svg).not.toContain("url(");
    expect(result.svg).not.toContain("evil.test");
  });

  it("is deterministic and idempotent once changed", () => {
    const input =
      '<svg viewBox="0 0 4 4"><path d="M0 0h4" onclick="x()"/></svg>';
    const first = sanitizeSvgIcon(input);
    const second = sanitizeSvgIcon(input);
    expect(first.svg).toBe(second.svg);
    const again = sanitizeSvgIcon(first.svg);
    expect(again.changed).toBe(false);
    expect(again.svg).toBe(first.svg);
  });

  it("rejects declarations outright: DOCTYPE, entities, CDATA, processing instructions", () => {
    for (const bad of [
      '<!DOCTYPE svg [<!ENTITY x "y">]><svg viewBox="0 0 1 1"><path d="M0 0"/></svg>',
      '<?php echo 1 ?><svg><path d="M0 0"/></svg>',
      '<svg><![CDATA[<script>]]><path d="M0 0"/></svg>',
    ]) {
      expect(message(() => sanitizeSvgIcon(bad))).toContain("must not carry");
    }
    // The xml declaration itself is harmless: tolerated, and since
    // nothing needs removing the original bytes return unchanged.
    const declared = `<?xml version="1.0"?>${CLEAN}`;
    const result = sanitizeSvgIcon(declared);
    expect(result.changed).toBe(false);
    expect(result.svg).toBe(declared);
  });

  it("rejects not-SVG, oversize, and hostile-only inputs with the documented wordings", () => {
    // Bare text refuses as not well-formed.
    expect(message(() => sanitizeSvgIcon("not markup"))).toContain("SVG");
    expect(message(() => sanitizeSvgIcon("<div>hi</div>"))).toContain(
      "svg",
    );
    expect(
      message(() =>
        sanitizeSvgIcon(`<svg>${"<g>".repeat(1)}${"x".repeat(ICON_SVG_BYTE_CAP)}</g></svg>`),
      ),
    ).toContain("KB");
    // Hostile-only: everything stripped must reject, never an empty icon.
    expect(
      message(() =>
        sanitizeSvgIcon('<svg viewBox="0 0 1 1"><script>x</script></svg>'),
      ),
    ).toContain("Nothing drawable");
  });

  it("rejects CSS-escaped references, malformed XML, and geometry-stripped drawables", () => {
    // A backslash escape decodes to url() in CSS — the value scan
    // rejects backslashes wholesale.
    const escaped = sanitizeSvgIcon(
      '<svg viewBox="0 0 4 4"><path d="M0 0h4" fill="\\75\\72\\6c(#x)"/></svg>',
    );
    expect(escaped.dropped.map((d) => d.name)).toContain("fill");
    expect(escaped.svg).not.toContain("\\75");
    // Malformed-but-clean input must reject, not return byte-stable.
    expect(
      message(() =>
        sanitizeSvgIcon(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><path d="M0 0h4"</svg>',
        ),
      ),
    ).toContain("well-formed");
    // A drawable whose geometry did not survive the filter is not
    // drawable — the silent-empty case rejects.
    expect(
      message(() =>
        sanitizeSvgIcon('<svg viewBox="0 0 4 4"><path onclick="x()"/></svg>'),
      ),
    ).toContain("Nothing drawable");
  });

  it("bounds depth and element count", () => {
    const deep = `<svg viewBox="0 0 1 1">${"<g>".repeat(40)}<path d="M0 0"/>${"</g>".repeat(40)}</svg>`;
    expect(message(() => sanitizeSvgIcon(deep))).toContain("deeper");
    const wide = `<svg viewBox="0 0 1 1">${'<circle cx="0" cy="0" r="1"/>'.repeat(5_001)}</svg>`;
    expect(message(() => sanitizeSvgIcon(wide))).toContain("more elements");
  });

  it("injects the SVG namespace when absent and derives the aspect", () => {
    const bare = '<svg viewBox="0 0 32 16"><path d="M0 0h32"/></svg>';
    const result = sanitizeSvgIcon(bare);
    expect(result.changed).toBe(true);
    expect(result.svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(result.aspect).toBe(2);
    // A foreign xmlns is dropped and replaced with the SVG namespace.
    const foreign =
      '<svg xmlns="http://evil.test/ns" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>';
    const fixed = sanitizeSvgIcon(foreign);
    expect(fixed.svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(fixed.svg).not.toContain("evil.test");
  });
});
