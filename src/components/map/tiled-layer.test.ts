import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { MVTLayer } from "@deck.gl/geo-layers";
import { describe, expect, it } from "vitest";

import { defaultStyle } from "@/lib/style/defaults";
import type { LiveWindowing } from "./text-sublayer";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS image check, no declaration file on purpose.
import { MVT_WORKER_IMAGE_PATH } from "../../../scripts/check-image-inventory.mjs";
import {
  createTiledLayer,
  LOADERS_GL_MVT_VERSION,
  MVT_WORKER_URL,
} from "./tiled-layer";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const WORKER = join(ROOT, "public", MVT_WORKER_URL.slice(1));
const UPSTREAM_WORKER = join(
  ROOT,
  "node_modules",
  "@loaders.gl",
  "mvt",
  "dist",
  "mvt-worker.js",
);

describe("application-owned MVT worker", () => {
  it("pins the asset to the installed parser version and exact upstream bundle", () => {
    const packageMetadata = JSON.parse(
      readFileSync(
        join(ROOT, "node_modules", "@loaders.gl", "mvt", "package.json"),
        "utf8",
      ),
    ) as { version: string };
    const packageLock = JSON.parse(
      readFileSync(join(ROOT, "package-lock.json"), "utf8"),
    ) as { packages: Record<string, { version?: string }> };
    const vendored = readFileSync(WORKER, "utf8");
    const upstream = readFileSync(UPSTREAM_WORKER, "utf8");
    const upstreamStart = vendored.indexOf('"use strict";');

    expect(packageMetadata.version).toBe(LOADERS_GL_MVT_VERSION);
    expect(
      packageLock.packages["node_modules/@loaders.gl/mvt"].version,
    ).toBe(LOADERS_GL_MVT_VERSION);
    expect(MVT_WORKER_URL).toContain(LOADERS_GL_MVT_VERSION);
    expect(MVT_WORKER_IMAGE_PATH).toBe(`/app/public${MVT_WORKER_URL}`);
    expect(upstreamStart).toBeGreaterThan(0);
    expect(vendored.slice(upstreamStart)).toBe(upstream);
  });

  it("carries the upstream notice and every bundled third-party attribution", () => {
    const worker = readFileSync(WORKER, "utf8");
    const notice = readFileSync(join(ROOT, "NOTICE"), "utf8");

    expect(worker.slice(0, worker.indexOf('"use strict";'))).toContain(
      "SPDX-License-Identifier: MIT",
    );
    expect(worker.slice(0, worker.indexOf('"use strict";'))).toContain(
      "Copyright (c) vis.gl contributors",
    );
    expect(worker.slice(0, worker.indexOf('"use strict";'))).toContain(
      "Copyright (c) 2015 Uber Technologies, Inc.",
    );
    expect(notice).toContain("Copyright (c) 2015 Uber Technologies, Inc.");
    for (const attribution of [
      "loaders.gl MVT parser worker",
      "@math.gl/polygon",
      "@probe.gl/env",
      "@probe.gl/log",
      "Mapbox earcut",
      "pbf",
      "vector-tile-js",
      "ieee754",
    ]) {
      expect(notice).toContain(attribution);
    }
  });

  it("uses an application-origin URL instead of a public worker host", () => {
    const application = new URL("https://dezfil.invalid/maps/example");
    const worker = new URL(MVT_WORKER_URL, application);

    expect(MVT_WORKER_URL.startsWith("/workers/")).toBe(true);
    expect(worker.origin).toBe(application.origin);
    expect(worker.hostname).toBe("dezfil.invalid");
  });
});

describe("the attribution ledger", () => {
  it("keeps the credits the borrowed palettes require", () => {
    const notice = readFileSync(join(ROOT, "NOTICE"), "utf8");

    for (const attribution of [
      "CARTO Colors (CC-BY 4.0",
      "kepler.gl (MIT, © Uber Technologies / OpenJS Foundation)",
      "matplotlib colormaps (CC0",
      "Turbo colormap (Apache-2.0",
      "Scientific colour maps (MIT",
      "ColorBrewer (Apache-2.0",
    ]) {
      expect(notice).toContain(attribution);
    }
  });
});

describe("createTiledLayer", () => {
  const tiled = {
    id: "neighborhoods",
    style: defaultStyle("POLYGON"),
    viz: { type: "points" } as const,
    tiles: {
      url: "/api/layers/neighborhoods/tiles/{z}/{x}/{y}",
      minZoom: 2,
      maxZoom: 14,
    },
  };

  it("keeps parsing on the MVT worker while replacing the CDN fallback", () => {
    const result = createTiledLayer(tiled, {
      interactive: true,
      markScale: 1,
    }) as MVTLayer;
    const props = result.props as typeof result.props & {
      loaders: Array<{
        id: string;
        version: string;
        worker: boolean;
        parse?: unknown;
      }>;
      loadOptions: {
        core: { worker: boolean };
        mvt: { workerUrl: string };
      };
    };

    expect(result).toBeInstanceOf(MVTLayer);
    expect(props.id).toBe("neighborhoods:mvt");
    expect(props.data).toBe(tiled.tiles.url);
    expect(props.minZoom).toBe(2);
    expect(props.maxZoom).toBe(14);
    expect(props.binary).toBe(false);
    expect(props.pickable).toBe(true);
    expect(props.loadOptions).toEqual({
      core: { worker: true },
      mvt: { workerUrl: MVT_WORKER_URL },
    });
    expect(props.loaders[0]).toMatchObject({
      id: "mvt",
      version: LOADERS_GL_MVT_VERSION,
      worker: true,
    });
    // MVTLayer deliberately selects MVTWorkerLoader: it has no main-thread
    // parser to fall back to, so this assertion catches worker theater.
    expect(props.loaders[0].parse).toBeUndefined();
    expect(JSON.stringify(props.loadOptions)).not.toContain("unpkg.com");
  });

  it("preserves windowing, extrusion and tiled-label construction", () => {
    const filter = {};
    const getFilterValue = () => [1];
    const windowing: LiveWindowing = {
      dims: [],
      trigger: "range:year",
      props: {
        extensions: [filter],
        filterRange: [[2000, 2020]],
        getFilterValue,
      },
    };
    const result = createTiledLayer(
      {
        ...tiled,
        style: {
          ...tiled.style,
          heightBy: {
            attribute: "height",
            domain: [0, 100],
            range: [0, 1_000],
          },
          label: {
            attribute: "name",
            size: 12,
            color: { r: 255, g: 255, b: 255, a: 1 },
            haloWidth: 1,
            haloColor: { r: 12, g: 16, b: 24, a: 0.8 },
          },
        },
      },
      { interactive: false, markScale: 2, windowing },
    ) as MVTLayer;
    const props = result.props as typeof result.props & {
      extensions: unknown[];
      filterRange: number[][];
      getFilterValue: typeof getFilterValue;
      renderSubLayers: unknown;
      updateTriggers: Record<string, unknown>;
    };

    expect(props.id).toBe("neighborhoods:mvt:windowed");
    expect(props.pickable).toBe(false);
    expect(props.extensions).toEqual([filter]);
    expect(props.filterRange).toEqual([[2000, 2020]]);
    expect(props.getFilterValue).toBe(getFilterValue);
    expect(props.extruded).toBe(true);
    expect(props.updateTriggers.getFilterValue).toBe("range:year");
    expect(props.updateTriggers.getElevation).toEqual([
      {
        attribute: "height",
        domain: [0, 100],
        range: [0, 1_000],
      },
    ]);
    expect(props.renderSubLayers).toBeTypeOf("function");
  });

  it("rejects construction without a usable tiled source", () => {
    expect(() =>
      createTiledLayer(
        { ...tiled, tiles: null },
        { interactive: true, markScale: 1 },
      ),
    ).toThrow("requires a tile URL");
  });
});
