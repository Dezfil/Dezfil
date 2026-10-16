import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BasemapPanel } from "@/components/builder/BasemapPanel";
import { HostEvent, installDomHost, type HostElement } from "@/components/testing/dom-host";
import { BASEMAPS, SATELLITE_STYLE_URL, type BasemapStyle } from "@/lib/basemap";
import type { CustomBasemap } from "@/lib/metadata/maps";
import { BasemapPicker } from "./BasemapPicker";

/**
 * The two places a person chooses a basemap, the builder's panel and the
 * published reader's switcher, draw a card for each style the server
 * handed down as offered. A style an admin hid arrives marked, so the page
 * can still draw a map on it, and gets no card, even on the map that is on
 * it; Auto is always a card.
 */
const SATELLITE: BasemapStyle = { key: "satellite", label: "Satellite", url: SATELLITE_STYLE_URL, kind: "imagery",
  attribution: [{ label: "© Imagery Provider" }] };
const marked = (hidden: string[]) =>
  [...BASEMAPS, SATELLITE].map((b) => ({ ...b, offered: !hidden.includes(b.key) }));
/** The note under the previews, which are captures of the built-in styles:
 * their credit in the words the open map's corner uses. */
const PREVIEWS = "Previews: © OpenMapTiles · © OpenStreetMap";
/** What a picker says on a map on Satellite where the instance draws no
 * imagery, so the default style is drawn in its place. */
const NO_IMAGERY = "No satellite imagery is available on this instance, so this map shows the default style.";

describe("the builder's basemap panel", () => {
  const cards = (basemaps: BasemapStyle[]) =>
    [...renderToStaticMarkup(
      <BasemapPanel active="streets" custom={null} onSaveCustom={async () => true} onRemoveCustom={() => {}}
        groupsPresent={null} overridden={false} basemaps={basemaps} onPick={() => {}} layerToggles={null}
        onToggleGroup={() => {}} statusPillVisible onToggleStatusPill={() => {}} />,
    ).matchAll(/<span class="[^"]*label[^"]*">([^<]+)<\/span>/g)].map((m) => m[1]);

  it("draws a card for every offered style, Auto first", () => {
    expect(cards(marked([]))).toEqual(["Auto", "Dark", "Light", "Streets", "Satellite"]);
  });

  it("draws no card for a hidden style, the map's own included", () => {
    expect(cards(marked(["streets", "satellite"]))).toEqual(["Auto", "Dark", "Light"]);
  });

  it("credits the previews in the built-in credit's words", () => {
    const html = renderToStaticMarkup(
      <BasemapPanel active="streets" custom={null} onSaveCustom={async () => true} onRemoveCustom={() => {}}
        groupsPresent={null} overridden={false} basemaps={marked([])} onPick={() => {}} layerToggles={null}
        onToggleGroup={() => {}} statusPillVisible onToggleStatusPill={() => {}} />,
    ).replace(/<!-- -->/g, "");
    expect(html).toContain(`>${PREVIEWS}</p>`);
  });

  const panel = (active: "satellite" | "streets", basemaps: BasemapStyle[], custom: CustomBasemap | null = null) =>
    renderToStaticMarkup(
      <BasemapPanel active={active} custom={custom} onSaveCustom={async () => true} onRemoveCustom={() => {}}
        groupsPresent={null} overridden={false} basemaps={basemaps} onPick={() => {}} layerToggles={null}
        onToggleGroup={() => {}} statusPillVisible onToggleStatusPill={() => {}} />,
    );

  it("says on a Satellite map with no imagery on the instance that the default style is shown, in the panel's note", () => {
    expect(panel("satellite", BASEMAPS)).toContain(`>${NO_IMAGERY}</p>`);
  });

  it("says nothing of the kind where the imagery is drawn, hidden from the pickers or not, on another style, or under the map's own style", () => {
    expect(panel("satellite", marked([]))).not.toContain(NO_IMAGERY);
    expect(panel("satellite", marked(["satellite"]))).not.toContain(NO_IMAGERY);
    expect(panel("streets", BASEMAPS)).not.toContain(NO_IMAGERY);
    expect(panel("satellite", BASEMAPS, { url: "https://styles.example/own.json", name: "Own", attribution: [] })).not.toContain(NO_IMAGERY);
  });
});

describe("the published reader's basemap switcher", () => {
  let host: ReturnType<typeof installDomHost>;
  let root: ReturnType<typeof createRoot>;
  let container: HostElement;
  beforeEach(() => {
    host = installDomHost();
    container = host.document.body.appendChild(host.document.createElement("div"));
    root = createRoot(container as unknown as Element);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.uninstall();
  });

  async function opened(basemaps: BasemapStyle[], active: "satellite" | "streets" = "streets") {
    await act(async () => root.render(<BasemapPicker active={active} pinned={false} basemaps={basemaps} onPick={() => {}} />));
    const trigger = container.querySelectorAll("button")[0];
    await act(async () => trigger.dispatchEvent(new HostEvent("click", { bubbles: true, cancelable: true })));
    return container.querySelectorAll("button").slice(1).map((button) => button.textContent);
  }

  it("draws a card for every offered style, Auto first", async () => {
    expect(await opened(marked([]))).toEqual(["Auto", "Dark", "Light", "Streets", "Satellite"]);
  });

  it("draws no card for a hidden style, the map's own included", async () => {
    expect(await opened(marked(["streets", "satellite"]))).toEqual(["Auto", "Dark", "Light"]);
  });

  it("credits the previews in the built-in credit's words", async () => {
    await opened(marked([]));
    expect(container.querySelectorAll("p").map((p) => p.textContent)).toContain(PREVIEWS);
  });

  it("says on a Satellite map with no imagery on the instance that the default style is shown", async () => {
    await opened(BASEMAPS, "satellite");
    expect(container.querySelectorAll("p").map((p) => p.textContent)).toContain(NO_IMAGERY);
  });

  it("says nothing of the kind where the imagery is drawn", async () => {
    await opened(marked(["satellite"]), "satellite");
    expect(container.querySelectorAll("p").map((p) => p.textContent)).not.toContain(NO_IMAGERY);
  });
});
