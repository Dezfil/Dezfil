import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, afterEach } from "vitest";
import { BasemapPanel } from "./BasemapPanel";
import { availableBasemaps } from "@/lib/basemap";

/**
 * Imagery is a configured basemap: a card for it in every install would
 * occupy picker space for a service most installs do not have.
 */
describe("the basemap panel's imagery card", () => {
  afterEach(() => {
    delete process.env.DEZFIL_SATELLITE_URL;
    delete process.env.DEZFIL_SATELLITE_ATTRIBUTION;
  });

  const markup = () =>
    renderToStaticMarkup(
      <BasemapPanel
        active={null}
        custom={null}
        onSaveCustom={async () => true}
        onRemoveCustom={() => {}}
        groupsPresent={null}
        overridden={false}
        basemaps={availableBasemaps()}
        onPick={() => {}}
        layerToggles={null}
        onToggleGroup={() => {}}
        statusPillVisible
        onToggleStatusPill={() => {}}
      />,
    );

  it("is absent while no imagery is configured", () => {
    const html = markup();
    expect(html).toContain("Streets");
    expect(html).not.toContain("Satellite");
  });

  it("appears once imagery is configured", () => {
    process.env.DEZFIL_SATELLITE_URL =
      "https://imagery.example/tiles/{z}/{y}/{x}?key=SECRET";
    process.env.DEZFIL_SATELLITE_ATTRIBUTION = "© Imagery Provider";
    expect(markup()).toContain("Satellite");
  });

  it("never names a provider the instance did not configure", () => {
    expect(markup()).not.toContain("Esri");
  });
});
