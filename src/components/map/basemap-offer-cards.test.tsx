import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BasemapPanel } from "@/components/builder/BasemapPanel";
import { HostEvent, installDomHost, type HostElement } from "@/components/testing/dom-host";
import { BASEMAPS, SATELLITE_STYLE_URL, type BasemapStyle } from "@/lib/basemap";
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

  async function opened(basemaps: BasemapStyle[]) {
    await act(async () => root.render(<BasemapPicker active="streets" pinned={false} basemaps={basemaps} onPick={() => {}} />));
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
});
