import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, afterEach } from "vitest";
import { BasemapCredit } from "./BasemapCredit";
import { resolveBasemapAttribution } from "@/lib/basemap";

/** A credit nobody can follow is not a credit: the required OpenStreetMap
 * line has to reach the copyright page from the rendered footer, and an
 * instance serving its own tiles has to credit its own provider. */
describe("BasemapCredit", () => {
  afterEach(() => {
    delete process.env.DEZFIL_BASEMAP_URL;
    delete process.env.DEZFIL_BASEMAP_ATTRIBUTION;
  });

  it("renders the OpenStreetMap credit as a link to the copyright page", () => {
    const html = renderToStaticMarkup(
      <BasemapCredit lines={resolveBasemapAttribution("dark")} />,
    );
    expect(html).toContain(
      '<a href="https://www.openstreetmap.org/copyright"',
    );
    expect(html).toContain("OpenStreetMap contributors</a>");
  });

  it("renders the configured credit under a deployment override", () => {
    process.env.DEZFIL_BASEMAP_URL = "https://tiles.internal/style.json";
    process.env.DEZFIL_BASEMAP_ATTRIBUTION = "© Internal Tiles";
    const html = renderToStaticMarkup(
      <BasemapCredit lines={resolveBasemapAttribution(null)} />,
    );
    expect(html).toContain("© Internal Tiles");
    expect(html).not.toContain("OpenMapTiles");
  });
});
