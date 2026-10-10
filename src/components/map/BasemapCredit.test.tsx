import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, afterEach, vi } from "vitest";
import { BasemapCredit } from "./BasemapCredit";
import { BASEMAPS, basemapCreditIn } from "@/lib/basemap";
import { basemapOverrideAttribution } from "@/lib/basemap-offer";

/** A credit nobody can follow is not a credit: the required OpenStreetMap
 * line has to reach the copyright page from the rendered footer, and an
 * instance serving its own tiles has to credit its own provider. */
describe("BasemapCredit", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("renders the OpenStreetMap credit as a link to the copyright page", () => {
    const html = renderToStaticMarkup(
      <BasemapCredit lines={basemapCreditIn(BASEMAPS, "dark")} />,
    );
    expect(html).toContain(
      '<a href="https://www.openstreetmap.org/copyright"',
    );
    expect(html).toContain("OpenStreetMap contributors</a>");
  });

  it("renders the configured credit under a deployment override", () => {
    vi.stubEnv("DEZFIL_BASEMAP_URL", "https://tiles.internal/style.json");
    vi.stubEnv("DEZFIL_BASEMAP_ATTRIBUTION", "© Internal Tiles");
    const html = renderToStaticMarkup(
      <BasemapCredit lines={basemapOverrideAttribution()} />,
    );
    expect(html).toContain("© Internal Tiles");
    expect(html).not.toContain("OpenMapTiles");
  });
});
