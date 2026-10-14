import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { DataTable } from "../api";
import { useLayerSourceCoordinator } from "./use-layer-source-coordinator";

it.each([["order", '"order"'], ["places", "places"]])("quotes the batch import reference %s when needed", async (name, reference) => {
  vi.useFakeTimers();
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  const request = vi.fn<typeof fetch>(async () => Response.json({ error: { message: "Refused" } }, { status: 400 }));
  let port!: ReturnType<typeof useLayerSourceCoordinator>;
  function Probe() {
    port = useLayerSourceCoordinator({ mapId: "map", projectId: null, request, reload() {}, edited() {}, setSelectedId() {}, setFitBounds() {}, patchLayer: async () => null });
    return null;
  }
  try {
    renderToStaticMarkup(<Probe />);
    port.onCatalogTableImported({ name, geometryColumn: "geometry" } as DataTable);
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(request.mock.calls[0][1]?.body)).sql).toBe(`SELECT * FROM ${reference}`);
  } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
});
