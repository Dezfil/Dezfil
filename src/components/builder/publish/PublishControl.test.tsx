import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MapWithLayers } from "@/lib/metadata/maps";
import { PublishControl } from "./PublishControl";
import { PublishPopover } from "./PublishPopover";

/**
 * The builder's Publish control over a map someone else owns: an Editor
 * reads that the map is published, and since when, but never its link,
 * which is the owner's to hand out. The owner's own map keeps the link.
 */
vi.mock("@/components/theme", () => ({ useTheme: () => ({ theme: "light" }) }));

const map = (over: Partial<MapWithLayers>): MapWithLayers =>
  ({ id: "m", name: "Station catchments", layers: [], updatedAt: "2026-09-02T00:00:00Z",
    publishToken: null, publishedAt: "2026-09-01T00:00:00Z", published: true, ...over }) as MapWithLayers;

describe("the Publish control over someone else's published map", () => {
  it("says Published on its trigger, as on the owner's", () => {
    for (const shown of [map({}), map({ publishToken: "token-owner" })]) {
      const html = renderToStaticMarkup(<PublishControl map={shown} onChange={() => {}} />);
      expect(html).toContain('data-published="true"');
      expect(html).toContain(">Published<");
    }
    const draft = renderToStaticMarkup(<PublishControl map={map({ published: false, publishedAt: null })} onChange={() => {}} />);
    expect(draft).toContain(">Publish<");
  });

  it("shows the live state without the link, the copy or the embed to an Editor, and offers no Publish map", () => {
    const html = renderToStaticMarkup(<PublishPopover map={map({})} onChange={() => {}} />);
    expect(html).toContain("Published");
    expect(html).not.toContain("Publish map");
    expect(html).not.toContain("Copy link");
    expect(html).not.toContain("Embed");
    expect(html).not.toContain("/v/");
    const owner = renderToStaticMarkup(<PublishPopover map={map({ publishToken: "token-owner" })} onChange={() => {}} />);
    expect(owner).toContain("Copy link");
    expect(owner).toContain("/v/token-owner");
  });
});
