import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectCrumbTailView } from "./ProjectCrumbTail";

/**
 * The project-home header state at its component boundary: the bold
 * rename-on-click name and the editing input. The on-route walk lands
 * with, which mounts the portal on the real project page.
 */

const noop = () => {};

describe("the project crumb tail (reference row 6)", () => {
  it("renders the bold name as the rename affordance", () => {
    const html = renderToStaticMarkup(
      <ProjectCrumbTailView
        name="Berlin mobility study"
        editing={false}
        value=""
        onValue={noop}
        onStart={noop}
        onCommit={noop}
        onCancel={noop}
      />,
    );
    expect(html).toContain("Berlin mobility study");
    expect(html).toContain('title="Rename Berlin mobility study"');
    expect(html).toContain("<button");
    // Plain text: no colour dot, no caret glyph beside the name.
    expect(html).not.toContain("svg");
  });

  it("renders the editing input with the draft value and its label", () => {
    const html = renderToStaticMarkup(
      <ProjectCrumbTailView
        name="Berlin mobility study"
        editing={true}
        value="Flood atlas"
        onValue={noop}
        onStart={noop}
        onCommit={noop}
        onCancel={noop}
      />,
    );
    expect(html).toContain('aria-label="Project name"');
    expect(html).toContain('value="Flood atlas"');
    expect(html).not.toContain("<button");
  });
});
