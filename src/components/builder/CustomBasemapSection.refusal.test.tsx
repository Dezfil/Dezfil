import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SINGLE_MAP_STYLES_OFF } from "@/lib/basemap";
import type { CustomBasemap, MapWithLayers } from "@/lib/metadata/maps";
import { installDomHost, type HostElement } from "../testing/dom-host";
import { BasemapTab } from "./BasemapTab";
import { CustomBasemapSection } from "./CustomBasemapSection";

/**
 * While the instance takes no style address its library does not offer, the
 * builder's paste control is drawn disabled with the rule's sentence, for
 * everyone: the dashed door opens no form and a saved style's Change is
 * inert, both described by the sentence, while Remove still clears the
 * map's style. The Basemap tab learns the switch from the runtime read.
 */
const PASTED: CustomBasemap = { url: "https://styles.example/pasted.json", name: "Pasted", attribution: [] };

let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;
beforeEach(() => {
  host = installDomHost(); container = host.document.body.appendChild(host.document.createElement("div"));
  root = createRoot(container as unknown as Element);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); host.uninstall(); });

const button = (label: string) => container.querySelectorAll("button").find(b => b.textContent.trim().endsWith(label));
const sentence = () => container.querySelectorAll("p").find(p => p.textContent === SINGLE_MAP_STYLES_OFF);
const urlField = () => container.querySelector('input[type="url"]');

async function section(custom: CustomBasemap | null, refusal: string | null, onRemove = vi.fn()) {
  await act(async () => root.render(<CustomBasemapSection custom={custom} onSave={async () => true} onRemove={onRemove} refusal={refusal} />));
  return onRemove;
}

describe("the paste control", () => {
  it("opens its form while a pasted address is taken", async () => {
    await section(null, null);
    expect(button("Custom…")!.disabled).toBe(false);
    expect(sentence()).toBeUndefined();
    await act(async () => button("Custom…")!.click());
    expect(urlField()).toBeTruthy();
  });

  it("is disabled with the rule's sentence while none is taken, and opens nothing", async () => {
    await section(null, SINGLE_MAP_STYLES_OFF);
    const door = button("Custom…")!;
    expect(door.disabled).toBe(true);
    expect(sentence()).toBeTruthy();
    expect(door.getAttribute("aria-describedby")).toBe(sentence()!.id);
    await act(async () => door.click());
    expect(urlField()).toBeNull();
  });

  it("keeps a map's pasted style, its Change disabled with the sentence and its Remove working", async () => {
    const onRemove = await section(PASTED, SINGLE_MAP_STYLES_OFF);
    expect(container.textContent).toContain("Pasted");
    const change = button("Change")!;
    expect(change.disabled).toBe(true);
    expect(change.getAttribute("aria-describedby")).toBe(sentence()!.id);
    await act(async () => change.click());
    expect(urlField()).toBeNull();
    expect(button("Remove")!.disabled).toBe(false);
    await act(async () => button("Remove")!.click());
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it("closes an open form when the switch turns off under it", async () => {
    await section(null, null);
    await act(async () => button("Custom…")!.click());
    expect(urlField()).toBeTruthy();
    await section(null, SINGLE_MAP_STYLES_OFF);
    expect(urlField()).toBeNull();
    expect(button("Custom…")!.disabled).toBe(true);
  });
});

describe("the Basemap tab", () => {
  const map = { basemap: null, customBasemap: null, basemapLayers: null } as unknown as MapWithLayers;
  async function tab(config: Record<string, unknown> | null) {
    vi.stubGlobal("fetch", vi.fn(async () => (config ? Response.json(config) : new Response(null, { status: 500 }))));
    await act(async () => root.render(<BasemapTab map={map} loadedGroups={null} overridden={false} patchMap={vi.fn(async () => true)}
      statusPillVisible={false} onToggleStatusPill={() => {}} />));
  }

  it("draws the paste control disabled with the sentence when the runtime read says the switch is off", async () => {
    await tab({ basemapStyles: [], singleMapStyles: false });
    expect(button("Custom…")!.disabled).toBe(true);
    expect(sentence()).toBeTruthy();
  });

  it("draws it enabled when the switch is on, and when the read fails", async () => {
    await tab({ basemapStyles: [], singleMapStyles: true });
    expect(button("Custom…")!.disabled).toBe(false);
    expect(sentence()).toBeUndefined();
    await act(async () => root.unmount());
    root = createRoot(container as unknown as Element);
    await tab(null);
    expect(button("Custom…")!.disabled).toBe(false);
  });
});
