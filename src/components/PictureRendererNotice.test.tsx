import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { PictureRendererNotice, RENDERER_SETTINGS_HREF } from "./PictureRendererNotice";

/**
 * The line that tells an administrator why no card has a picture: one
 * sentence, set as the pictures' credit line is, with the System tab as
 * its one link; nothing at all for anyone it is not handed to.
 */

it("says why there are no map pictures and where to set a renderer, its one link to the System tab's renderer row", () => {
  const html = renderToStaticMarkup(<PictureRendererNotice shown />);
  const text = html.replace(/<[^>]+>/g, "");
  expect(text).toBe("No map pictures: this instance has no renderer. Settings · System says how to set one.");
  expect([...html.matchAll(/<a [^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/g)].map((m) => [m[1], m[2]]))
    .toEqual([[RENDERER_SETTINGS_HREF, "Settings · System"]]);
  expect(RENDERER_SETTINGS_HREF).toBe("/settings/system#sys-renderer");
  expect(html).toContain("data-renderer-notice");
  expect(text).not.toMatch(/—/);
});

it.each([false, undefined])("draws nothing when it is not handed (%s)", (shown) => {
  expect(renderToStaticMarkup(<PictureRendererNotice shown={shown} />)).toBe("");
});
