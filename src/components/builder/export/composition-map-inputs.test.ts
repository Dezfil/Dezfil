import { describe, expect, it } from "vitest";
import type { BasemapLayers } from "@/lib/basemap-layers";
import { buildCompositionMapInputs } from "./composition-map-inputs";

const storedHidden: BasemapLayers = {
  land: true,
  water: true,
  roads: false,
  borders: true,
  buildings: true,
  labels: false,
};

function assembled(
  definitionBasemapLayers: BasemapLayers | null | undefined,
) {
  return buildCompositionMapInputs({
    definitionBasemapLayers,
    storedBasemapLayers: storedHidden,
    basemapKey: null,
    appearance: "light",
    basemapUrl: "/style.json",
    basemapKind: "vector",
    fallbackColor: "#fff",
    layers: [],
    liveFilters: null,
    camera: { lng: 13.4, lat: 52.5, zoom: 11, pitch: 0, bearing: 0 },
  });
}

describe("export composition map inputs", () => {
  it("keeps explicit null as the host's all-groups-visible answer", () => {
    expect(assembled(null).basemapLayers).toBeNull();
  });

  it("inherits stored hidden groups only when the definition is absent", () => {
    expect(assembled(undefined).basemapLayers).toBe(storedHidden);
  });
});
