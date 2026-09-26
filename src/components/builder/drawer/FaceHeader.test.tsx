import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FaceHeader } from "./FaceHeader";

/** The header is a path of segments, never a tab strip. The
 * browser measurements live in e2e/pane-replacement.spec.ts; this holds
 * the markup facts the measurements rest on. */
describe("the face header's segments", () => {
  it("with a way back, the return is the word Tools and the name is a heading", () => {
    const html = renderToStaticMarkup(
      <FaceHeader title="Buffer" onBack={() => {}} onDismiss={() => {}} />,
    );
    // The return keeps its accessible name and gains its visible word.
    expect(html).toMatch(/<button[^>]*aria-label="Back to the tools"[^>]*>(?:<[^>]+>)*Tools/);
    expect(html).toMatch(/<h3[^>]*>(?:<[^>]+>)*Buffer/);
    // A path, not tabs: nothing here claims to switch panels.
    expect(html).not.toContain('role="tab');
    // The return comes before the name in reading order.
    expect(html.indexOf("Back to the tools")).toBeLessThan(html.indexOf(">Buffer<"));
  });

  it("without a way back, the single segment is the face's own name", () => {
    const html = renderToStaticMarkup(
      <FaceHeader
        title="Assistant"
        onDismiss={() => {}}
        dismissLabel="Close assistant"
        drawerDismiss={false}
      />,
    );
    expect(html).not.toContain("Back to the tools");
    expect(html).not.toContain(">Tools<");
    expect(html).toMatch(/<h3[^>]*>(?:<[^>]+>)*Assistant/);
    expect(html).toContain('aria-label="Close assistant"');
    expect(html).not.toContain("data-drawer-dismiss");
  });

  it("with segments off, the title is the plain heading it was, in no segment", () => {
    const html = renderToStaticMarkup(
      <FaceHeader title="Assistant" onDismiss={() => {}} segments={false} />,
    );
    // The word sits directly in the heading, no segment span, no glyph slot.
    expect(html).toMatch(/<h3 class="[^"]*">Assistant<\/h3>/);
    expect(html).not.toContain("data-face-name");
    // And the row wears one class, not the path's second.
    const head = html.match(/<div class="([^"]*)"/)![1];
    expect(head.split(" ")).toHaveLength(1);
  });
});

describe("the tool's glyph before its name", () => {
  it("draws the operation's mark inside the heading, before the word, hidden from assistive technology", () => {
    const html = renderToStaticMarkup(
      <FaceHeader
        title="Buffer"
        mark={{ symbol: "buffer", group: "Proximity" }}
        onBack={() => {}}
        onDismiss={() => {}}
      />,
    );
    const heading = html.slice(html.indexOf("<h3"), html.indexOf("</h3>"));
    expect(heading).toMatch(/data-face-glyph[^>]*aria-hidden="true"|aria-hidden="true"[^>]*data-face-glyph/);
    expect(heading).toContain('data-grp="Proximity"');
    // The two-tone set's grid, the catalog's own drawing.
    expect(heading).toContain('viewBox="0 0 40 40"');
    expect(heading.indexOf("data-face-glyph")).toBeLessThan(heading.indexOf("Buffer"));
  });

  it("draws none where no mark is given", () => {
    const html = renderToStaticMarkup(
      <FaceHeader title="Tools" onDismiss={() => {}} />,
    );
    expect(html).not.toContain("data-face-glyph");
  });
});
