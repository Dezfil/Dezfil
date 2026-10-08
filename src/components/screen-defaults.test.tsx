import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { InstanceDefaults } from "@/lib/settings/defaults";
import { installDomHost } from "./testing/dom-host";
import { ScreenDefaultsProvider, useOpeningDefaults, useScreenDefaults, type ScreenDefaults } from "./screen-defaults";

/**
 * A screen reads its defaults from the page's hand-down: now, or as they
 * stood when it opened. With nothing handed down it opens with the
 * product's own values.
 */

const PRODUCT = {
  "newMap.basemap": null, "newMap.latitude": 40, "newMap.longitude": 0, "newMap.zoom": 1.3, "newMap.legendCorner": null,
  "newLayer.colorCycle": "uber_viz_qualitative", "newLayer.pointOpacity": 72, "newLayer.lineOpacity": 95,
  "newLayer.areaOpacity": 50, "newLayer.lineWidth": 2, "newLayer.pointRadius": 3,
  "canvas.opens": "full", "canvas.minimap": "auto", "canvas.resultsBand": "closed",
  "sqlConsole.textSize": "12", "sqlConsole.lineWrap": false, "imageExport.width": "1920", "imageExport.shape": "4:3",
} as const satisfies InstanceDefaults;
const CHANGED = { ...PRODUCT, "canvas.opens": "framed", "sqlConsole.textSize": "16", "imageExport.shape": "16:9" } as const satisfies InstanceDefaults;
const LATER = { ...PRODUCT, "canvas.opens": "full", "sqlConsole.textSize": "11", "imageExport.shape": "1:1" } as const satisfies InstanceDefaults;

const read = (defaults: ScreenDefaults) => [defaults["canvas.opens"], defaults["sqlConsole.textSize"], defaults["imageExport.shape"]].join(" ");
function Now() {
  return <span data-now={read(useScreenDefaults())} />;
}
function Opening() {
  return <span data-opening={read(useOpeningDefaults())} />;
}

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

describe("a screen's defaults", () => {
  it("are the product's own, every one of the seven, outside a page that hands any down", () => {
    function Probe() {
      return <pre>{JSON.stringify(useScreenDefaults())}</pre>;
    }
    const markup = renderToStaticMarkup(<Probe />).replace(/^<pre>|<\/pre>$/g, "").replaceAll("&quot;", '"');
    expect(JSON.parse(markup)).toEqual({
      "canvas.opens": "full", "canvas.minimap": "auto", "canvas.resultsBand": "closed",
      "sqlConsole.textSize": "12", "sqlConsole.lineWrap": false, "imageExport.width": "1920", "imageExport.shape": "4:3",
    });
  });

  it("follow the page's hand-down now, and stay as they stood when the screen opened", async () => {
    const host = installDomHost();
    const root = createRoot(host.document.body as unknown as Element);
    cleanups.push(() => { act(() => root.unmount()); host.uninstall(); });
    const tree = (defaults: InstanceDefaults) => (
      <ScreenDefaultsProvider defaults={defaults}>
        <Now />
        <Opening />
      </ScreenDefaultsProvider>
    );
    await act(async () => root.render(tree(CHANGED)));
    const attribute = (name: string) => host.document.querySelectorAll(`[${name}]`)[0]?.getAttribute(name);
    expect([attribute("data-now"), attribute("data-opening")]).toEqual(["framed 16 16:9", "framed 16 16:9"]);
    await act(async () => root.render(tree(LATER)));
    expect([attribute("data-now"), attribute("data-opening")]).toEqual(["full 11 1:1", "framed 16 16:9"]);
  });
});
