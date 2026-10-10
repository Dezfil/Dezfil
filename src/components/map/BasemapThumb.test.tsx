import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BasemapThumb } from "./BasemapThumb";

const PUBLIC_DIR = fileURLToPath(new URL("../../../public/", import.meta.url));

/**
 * The captures a card actually asks the browser for, read back out of the
 * rendered markup rather than from the component's own list of them: a card
 * that paints no capture at all shows up here as an empty result, which is
 * exactly the failure a gradient fallback hides from the eye.
 */
function captures(html: string): string[] {
  return [...html.matchAll(/url\(([^)]+)\)/g)].map((match) => match[1]);
}

describe("BasemapThumb", () => {
  it("paints the imagery card with a capture that is really in the tree", () => {
    const asked = captures(renderToStaticMarkup(<BasemapThumb style="satellite" />));

    expect(asked).toEqual(["/basemaps/thumbs/satellite.webp"]);

    const asset = join(PUBLIC_DIR, asked[0].replace(/^\//, ""));
    expect(existsSync(asset)).toBe(true);
    // A WebP begins "RIFF" with "WEBP" at byte 8, so a renamed placeholder
    // cannot pass for the capture the card promises.
    const head = readFileSync(asset).subarray(0, 12);
    expect(head.subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect(head.subarray(8, 12).toString("latin1")).toBe("WEBP");
  });

  it("keeps a capture on every vector style and on both halves of Auto", () => {
    for (const key of ["dark", "light", "streets"] as const) {
      expect(captures(renderToStaticMarkup(<BasemapThumb style={key} />))).toEqual([
        `/basemaps/thumbs/${key}.webp`,
      ]);
    }

    expect(captures(renderToStaticMarkup(<BasemapThumb style="auto" />))).toEqual([
      "/basemaps/thumbs/dark.webp",
      "/basemaps/thumbs/light.webp",
    ]);
  });

  it("fills a box that draws its own edge when asked, with the same captures, and keeps its own size otherwise", () => {
    const filled = renderToStaticMarkup(<BasemapThumb style="auto" fill />);
    expect(filled).toMatch(/^<span[^>]*data-fill="true"/);
    expect(captures(filled)).toEqual(["/basemaps/thumbs/dark.webp", "/basemaps/thumbs/light.webp"]);
    expect(captures(renderToStaticMarkup(<BasemapThumb style="streets" fill />))).toEqual(["/basemaps/thumbs/streets.webp"]);
    expect(renderToStaticMarkup(<BasemapThumb style="auto" />)).not.toContain("data-fill");
  });
});
