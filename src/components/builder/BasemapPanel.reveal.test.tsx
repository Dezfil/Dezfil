import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { BasemapPanel } from "./BasemapPanel";
import { BASEMAPS, SATELLITE_STYLE_URL, type BasemapStyle } from "@/lib/basemap";

/**
 * Imagery is a configured basemap: a card for it in every install would
 * occupy picker space for a service most installs do not have. The panel
 * draws a card for each style the server handed down as offered.
 */
const SATELLITE: BasemapStyle = { key: "satellite", label: "Satellite", url: SATELLITE_STYLE_URL, kind: "imagery",
  attribution: [{ label: "© Imagery Provider" }] };

describe("the basemap panel's imagery card", () => {
  const markup = (basemaps: BasemapStyle[]) =>
    renderToStaticMarkup(
      <BasemapPanel
        active={null}
        custom={null}
        onSaveCustom={async () => true}
        onRemoveCustom={() => {}}
        groupsPresent={null}
        overridden={false}
        basemaps={basemaps}
        onPick={() => {}}
        layerToggles={null}
        onToggleGroup={() => {}}
        statusPillVisible
        onToggleStatusPill={() => {}}
      />,
    );

  it("is absent while no imagery is configured", () => {
    const html = markup(BASEMAPS);
    expect(html).toContain("Streets");
    expect(html).not.toContain("Satellite");
  });

  it("appears once imagery is configured", () => {
    expect(markup([...BASEMAPS, SATELLITE])).toContain("Satellite");
  });

  it("never names a provider the instance did not configure", () => {
    expect(markup([...BASEMAPS, SATELLITE])).not.toContain("Esri");
  });
});
