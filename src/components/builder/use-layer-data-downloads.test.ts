import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  layerDataDownloadUrls,
  scopeLayerDownloadRecords,
} from "./use-layer-data-downloads";
import {
  LayerDownloadPrepareOwnership,
  LayerDownloadStatusObservations,
  MAX_CONSECUTIVE_UNCONFIRMED_STATUS_OBSERVATIONS,
} from "./layer-download-control";

const COORDINATOR = join(
  process.cwd(),
  "src/components/builder/use-layer-data-downloads.ts",
);

describe("layer-data download coordinator", () => {
  it("builds the exact private prepare URL and encodes the layer path", () => {
    expect(layerDataDownloadUrls("layer/with ?#% ü", "geojson")).toEqual({
      prepare:
        "/api/layers/layer%2Fwith%20%3F%23%25%20%C3%BC/export/geojson?__ui_prepare=1",
    });
  });

  it("builds strict redemption, status, and release modes without ticket injection", () => {
    expect(
      layerDataDownloadUrls(
        "neighborhoods",
        "geoparquet",
        "ticket&__ui_release=1 /?#% ü",
      ),
    ).toEqual({
      prepare: "/api/layers/neighborhoods/export/geoparquet?__ui_prepare=1",
      download:
        "/api/layers/neighborhoods/export/geoparquet?__ui_download=ticket%26__ui_release%3D1%20%2F%3F%23%25%20%C3%BC",
      status:
        "/api/layers/neighborhoods/export/geoparquet?__ui_status=ticket%26__ui_release%3D1%20%2F%3F%23%25%20%C3%BC",
      release:
        "/api/layers/neighborhoods/export/geoparquet?__ui_status=ticket%26__ui_release%3D1%20%2F%3F%23%25%20%C3%BC&__ui_release=1",
    });
  });

  it("keeps layer bytes on the native attachment road", () => {
    const source = readFileSync(COORDINATOR, "utf8");

    expect(source).toMatch(/document\.createElement\(["']iframe["']\)/);
    expect(source).toMatch(/frame\.src\s*=\s*urls\.download/);
    expect(source).not.toMatch(/\.blob\s*\(/);
    expect(source).not.toMatch(/\.arrayBuffer\s*\(/);
    expect(source).not.toMatch(/URL\.createObjectURL\s*\(/);
    expect(source).not.toMatch(/["']blob:/);
  });

  it("keeps the production prepare road on the behaviorally tested bounded coordinator", () => {
    const source = readFileSync(COORDINATOR, "utf8");

    expect(source).toMatch(/startLayerDownloadPreparation\s*\(\s*\{/);
    expect(source).not.toMatch(
      /fetch\s*\(\s*layerDataDownloadUrls\([^)]*\)\.prepare/,
    );
  });

  it("releases a delayed ticket when departure lands after prepare headers", async () => {
    const ownership = new LayerDownloadPrepareOwnership();
    const abort = vi.fn();
    const release = vi.fn();
    let resolveTicket!: (ticket: string) => void;
    const delayedTicket = new Promise<string>((resolve) => {
      resolveTicket = resolve;
    });
    const settled = delayedTicket.then((ticket) =>
      ownership.acceptTicket(() => release(ticket)),
    );

    ownership.markHeadersReceived();
    ownership.depart(abort);
    expect(abort).not.toHaveBeenCalled();

    resolveTicket("prepared-after-unmount");
    await expect(settled).resolves.toBe(false);
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith("prepared-after-unmount");
  });

  it("still aborts preparation that has not answered", () => {
    const ownership = new LayerDownloadPrepareOwnership();
    const abort = vi.fn();

    ownership.depart(abort);

    expect(abort).toHaveBeenCalledOnce();
  });

  it("does not resurrect stale records across an A to B to A map change", () => {
    const a = {
      mapId: "map-a",
      active: { csv: "active-a" },
      failures: { geojson: "failed-a" },
    };

    const b = scopeLayerDownloadRecords(a, "map-b");
    expect(b).toEqual({ mapId: "map-b", active: {}, failures: {} });

    const backToA = scopeLayerDownloadRecords(b, "map-a");
    expect(backToA).toEqual({ mapId: "map-a", active: {}, failures: {} });
  });

  it("needs three consecutive unconfirmed status observations before failing", () => {
    const observations = new LayerDownloadStatusObservations();

    expect(MAX_CONSECUTIVE_UNCONFIRMED_STATUS_OBSERVATIONS).toBe(3);
    expect(observations.recordUnconfirmed()).toBe(false);
    expect(observations.recordUnconfirmed()).toBe(false);
    expect(observations.recordUnconfirmed()).toBe(true);
  });

  it("resets the unconfirmed status run after any valid status response", () => {
    const observations = new LayerDownloadStatusObservations();

    expect(observations.recordUnconfirmed()).toBe(false);
    expect(observations.recordUnconfirmed()).toBe(false);
    observations.recordValid();
    expect(observations.recordUnconfirmed()).toBe(false);
    expect(observations.recordUnconfirmed()).toBe(false);
    expect(observations.recordUnconfirmed()).toBe(true);
  });
});
