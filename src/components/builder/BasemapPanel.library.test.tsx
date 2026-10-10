import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryStyleOffer } from "@/lib/basemap";
import type { CustomBasemap, MapWithLayers } from "@/lib/metadata/maps";
import { installDomHost, type HostElement } from "../testing/dom-host";
import { BasemapPanel } from "./BasemapPanel";
import { BasemapTab } from "./BasemapTab";

/**
 * The builder's picker lists the styles the instance's library offers after
 * the built-in ones, and takes one by its id: the server copies it onto the
 * map. A map's copy of a library style is marked on that style's card, not
 * drawn again as the map's own pasted style; a pasted style keeps its tile.
 */
const HARBOUR: LibraryStyleOffer = { id: "style-harbour", name: "Harbour chart", url: "https://charts.example/harbour/style.json",
  attribution: [{ label: "© Fixture Charts" }] };
const GREY: LibraryStyleOffer = { id: "style-grey", name: "Works grey", url: "https://charts.example/grey/style.json", attribution: [{ label: "charts.example" }] };
const copyOf = (style: LibraryStyleOffer): CustomBasemap => ({ url: style.url, name: style.name, attribution: style.attribution });

let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;
beforeEach(() => {
  host = installDomHost(); container = host.document.body.appendChild(host.document.createElement("div"));
  root = createRoot(container as unknown as Element);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); host.uninstall(); });

const cards = () => container.querySelectorAll("button").map(button => button.textContent.trim()).filter(text => !/^(Hide|Show)/.test(text));
const card = (label: string) => container.querySelectorAll("button").find(button => button.textContent.trim() === label);

async function panel(custom: CustomBasemap | null, onPickLibrary = vi.fn()) {
  await act(async () => root.render(
    <BasemapPanel active={null} custom={custom} onSaveCustom={async () => true} onRemoveCustom={() => {}} groupsPresent={null}
      overridden={false} onPick={() => {}} libraryStyles={[HARBOUR, GREY]} onPickLibrary={onPickLibrary} layerToggles={null}
      onToggleGroup={() => {}} statusPillVisible={false} onToggleStatusPill={() => {}} />,
  ));
  return onPickLibrary;
}

describe("the builder's picker", () => {
  it("lists the library's styles after the built-in ones, before the map's own", async () => {
    await panel(null);
    expect(cards().slice(0, 7)).toEqual(["Auto", "Dark", "Light", "Streets", "Harbour chart", "Works grey", "+Custom…"]);
  });

  it("takes a library style by its id", async () => {
    const onPickLibrary = await panel(null);
    await act(async () => card("Works grey")!.click());
    expect(onPickLibrary).toHaveBeenCalledExactlyOnceWith("style-grey");
  });

  it("marks the card of the library style a map holds a copy of, and draws no tile for the copy", async () => {
    await panel(copyOf(HARBOUR));
    expect(card("Harbour chart")!.getAttribute("data-active")).toBe("true");
    expect(card("Works grey")!.getAttribute("data-active")).toBe("false");
    expect(card("Auto")!.getAttribute("data-active")).toBe("false");
    expect(container.textContent).toContain("Custom…");
    expect(container.textContent).not.toContain("Remove it to return to the choice underneath.");
  });

  it("keeps a pasted style's tile, marking no library card", async () => {
    await panel({ url: "https://styles.example/pasted.json", name: "Pasted", attribution: [] });
    expect(container.textContent).toContain("Pasted");
    expect(container.textContent).toContain("Remove it to return to the choice underneath.");
    expect(card("Harbour chart")!.getAttribute("data-active")).toBe("false");
  });
});

describe("the builder's Basemap tab", () => {
  const map = { basemap: null, customBasemap: null, basemapLayers: null } as unknown as MapWithLayers;
  async function tab(answer: () => Promise<Response>) {
    vi.stubGlobal("fetch", vi.fn(answer));
    const patchMap = vi.fn(async () => true);
    await act(async () => root.render(<BasemapTab map={map} loadedGroups={null} overridden={false} patchMap={patchMap}
      statusPillVisible={false} onToggleStatusPill={() => {}} />));
    return patchMap;
  }

  it("reads the offered styles from the runtime read and takes one through the library road", async () => {
    const patchMap = await tab(async () => Response.json({ basemapStyles: [HARBOUR, { id: 7 }, GREY] }));
    expect(vi.mocked(fetch)).toHaveBeenCalledExactlyOnceWith("/api/config", { cache: "no-store" });
    expect(cards().slice(4, 6)).toEqual(["Harbour chart", "Works grey"]);
    await act(async () => card("Harbour chart")!.click());
    expect(patchMap).toHaveBeenCalledExactlyOnceWith({ customBasemap: { libraryStyle: "style-harbour" } });
  });

  it("offers the built-in styles alone when the read fails", async () => {
    await tab(async () => new Response(null, { status: 500 }));
    expect(cards().slice(0, 5)).toEqual(["Auto", "Dark", "Light", "Streets", "+Custom…"]);
  });
});
