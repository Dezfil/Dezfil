import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PublishedPageNotFound from "./not-found";
import RenderNotFound from "../render/not-found";

/**
 * Each document root owns its not-found page. A published address that
 * resolves to nothing (a link taken down, or one never issued) answers with
 * the published view's documented presentation in the published chrome,
 * never the framework's bare page; the render route's is plain.
 */
describe("the published root's not-found page", () => {
  it("says the map is not found and the link no longer available, in the published chrome", () => {
    const markup = renderToStaticMarkup(<PublishedPageNotFound />);
    expect(markup).toMatch(/<h1[^>]*>Map not found<\/h1>/);
    expect(markup).toMatch(/<p[^>]*>This link is no longer available\.<\/p>/);
    // The published page's own wrapper, at its default theme.
    expect(markup).toMatch(/^<div data-published-view="true" data-view-theme="dark">/);
  });

  it("leaves the render route a plain page with no published chrome", () => {
    const markup = renderToStaticMarkup(<RenderNotFound />);
    expect(markup).toContain("Page not found");
    expect(markup).not.toContain("data-published-view");
    expect(markup).not.toContain("Map not found");
  });
});
