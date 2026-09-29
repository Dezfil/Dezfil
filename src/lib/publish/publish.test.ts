import { privateTileAccess } from "@/lib/tiles/access";
import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import {
  createMap,
  duplicateMap,
  mapWithLayers,
  removeMap,
  updateMap,
} from "@/lib/map-service";
import { setPublishedTheme } from "@/lib/metadata/maps";
import { createLayer, renderLayer, updateLayer } from "@/lib/layer-service";
import {
  computeWidgetValues,
  renderLayerWithSelections,
} from "@/lib/widget-service";
import {
  publishMap,
  unpublishMap,
  getPublishedView,
  resetPublishCache,
  sanitizePublishedRender,
} from "./publish-service";
import { removeTable } from "@/lib/table-service";
import { publishedMessage } from "@/lib/api/error-catalogue";
import { generateToken, TOKEN_LENGTH } from "./token";
import { rateLimit, resetRateLimits } from "./rate-limit";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
  resetPublishCache();
  resetRateLimits();
  const src = path.join(dir, "s.csv");
  await writeFile(src, "name,lon,lat\na,1,2\nb,3,4\n");
  await ingestFile(testAccountScope(), src, "s.csv");
});

afterEach(async () => {
  closeMetadataDb();
  resetQueryInstance();
  resetPublishCache();
  delete process.env.DEZFIL_DATA_DIR;
  delete process.env.DEZFIL_PUBLISH_FRESHNESS_S;
  await rm(dir, { recursive: true, force: true });
});

async function mapWithLayer() {
  const map = createMap(testAccountScope(), "m");
  await createLayer(testAccountScope(), map.id, { name: "l", sql: "SELECT * FROM s" });
  return map;
}

describe("generateToken", () => {
  it("is url-safe, of documented length, and non-repeating", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).toHaveLength(TOKEN_LENGTH);
    expect(a).toMatch(/^[0-9A-Za-z]+$/);
    expect(a).not.toBe(b);
  });
});

describe("publish / unpublish", () => {
  it("publishing is idempotent while published (same token)", async () => {
    const map = await mapWithLayer();
    const first = publishMap(testAccountScope(), map.id);
    const second = publishMap(testAccountScope(), map.id);
    expect(second.token).toBe(first.token);
  });

  it("the token is not derived from the map id or name", async () => {
    const a = createMap(testAccountScope(), "Shared Name");
    const b = createMap(testAccountScope(), "Shared Name");
    const ta = publishMap(testAccountScope(), a.id).token;
    const tb = publishMap(testAccountScope(), b.id).token;
    // Not the id, and two identically-named maps get unrelated tokens.
    expect(ta).not.toContain(a.id);
    expect(ta).not.toBe(tb);
  });

  it("resolves a published view and 404s an unknown token", async () => {
    const map = await mapWithLayer();
    const { token } = publishMap(testAccountScope(), map.id);
    const view = await getPublishedView(token, Date.now());
    expect(view?.name).toBe("m");
    expect(view?.layers[0].render.ok).toBe(true);
    expect(await getPublishedView("nope".repeat(6), Date.now())).toBeNull();
  });

  it("unpublish stops resolution immediately; republish rotates the token", async () => {
    const map = await mapWithLayer();
    const first = publishMap(testAccountScope(), map.id);
    unpublishMap(testAccountScope(), map.id);
    expect(await getPublishedView(first.token, Date.now())).toBeNull();
    const second = publishMap(testAccountScope(), map.id);
    expect(second.token).not.toBe(first.token);
  });

  it("map deletion revokes a warmed token", async () => {
    const map = await mapWithLayer();
    const { token } = publishMap(testAccountScope(), map.id);
    expect(await getPublishedView(token, Date.now())).not.toBeNull();

    await removeMap(testAccountScope(), map.id);
    expect(await getPublishedView(token, Date.now())).toBeNull();
    resetPublishCache();
    closeMetadataDb();
    expect(await getPublishedView(token, Date.now())).toBeNull();
  });

  it("an in-flight assembly cannot return or restore a revoked token", async () => {
    const map = await mapWithLayer();
    const { token } = publishMap(testAccountScope(), map.id);

    // Rendering crosses an asynchronous query boundary. The synchronous
    // mutation therefore lands after the ownership snapshot but before the
    // final durable check.
    const inFlight = getPublishedView(token, Date.now());
    unpublishMap(testAccountScope(), map.id);

    expect(await inFlight).toBeNull();
    expect(await getPublishedView(token, Date.now())).toBeNull();
    resetPublishCache();
    closeMetadataDb();
    expect(await getPublishedView(token, Date.now())).toBeNull();
  });

  it("an in-flight assembly cannot cross map deletion", async () => {
    const map = await mapWithLayer();
    const { token } = publishMap(testAccountScope(), map.id);

    const inFlight = getPublishedView(token, Date.now());
    await removeMap(testAccountScope(), map.id);

    expect(await inFlight).toBeNull();
    expect(await getPublishedView(token, Date.now())).toBeNull();
  });
});

describe("freshness bound", () => {
  it("serves within the bound from cache, refreshes after it", async () => {
    process.env.DEZFIL_PUBLISH_FRESHNESS_S = "30";
    const map = await mapWithLayer();
    const { token } = publishMap(testAccountScope(), map.id);
    const t0 = 1_000_000;
    const a = await getPublishedView(token, t0);
    const b = await getPublishedView(token, t0 + 10_000); // within bound
    expect(b).toBe(a); // same cached object
    const c = await getPublishedView(token, t0 + 31_000); // past bound
    expect(c).not.toBe(a); // recomputed
    expect(c?.name).toBe("m");
  });

  it("unpublish invalidates the cache even within the bound", async () => {
    const map = await mapWithLayer();
    const { token } = publishMap(testAccountScope(), map.id);
    const t0 = 2_000_000;
    await getPublishedView(token, t0);
    unpublishMap(testAccountScope(), map.id);
    expect(await getPublishedView(token, t0 + 1000)).toBeNull();
  });

  it("a metadata revision retires a cached note immediately", async () => {
    process.env.DEZFIL_PUBLISH_FRESHNESS_S = "30";
    const map = await mapWithLayer();
    const { token } = publishMap(testAccountScope(), map.id);
    const t0 = 3_000_000;
    const before = await getPublishedView(token, t0);
    expect(before?.widgets).toEqual([]); // no cards — as ever

    // Notes are widgets now; a fresh one must reach the viewer inside
    // the freshness bound like any metadata revision.
    updateMap(testAccountScope(), map.id, {
      widgets: [
        {
          id: "n1",
          type: "note",
          layerId: null,
          title: "Sources",
          field: null,
          agg: "count",
          aggField: null,
          unit: null,
          note: "Data © OSM",
          format: null,
          visible: true,
        },
      ],
    });
    const after = await getPublishedView(token, t0 + 1000);
    expect(after?.widgets).toHaveLength(1);
    expect(after?.widgets[0]).toMatchObject({
      type: "note",
      title: "Sources",
      note: "Data © OSM",
    });
  });

  it("a metadata revision retires cached basemap toggles", async () => {
    process.env.DEZFIL_PUBLISH_FRESHNESS_S = "30";
    const map = await mapWithLayer();
    const { token } = publishMap(testAccountScope(), map.id);
    const t0 = 4_000_000;
    const before = await getPublishedView(token, t0);
    expect(before?.basemapLayers).toBeNull(); // everything visible, as ever

    updateMap(testAccountScope(), map.id, { basemapLayers: { labels: false, roads: false } });
    const after = await getPublishedView(token, t0 + 1000);
    expect(after?.basemapLayers).toEqual({ labels: false, roads: false });
  });

  it("imagery resolves with its configured kind and credit in the payload", async () => {
    process.env.DEZFIL_PUBLISH_FRESHNESS_S = "30";
    const map = await mapWithLayer();
    const { token } = publishMap(testAccountScope(), map.id);
    const t0 = 6_000_000;
    const before = await getPublishedView(token, t0);
    // Default (Auto): vector, with the lean required credit
    // (OpenFreeMap's name is optional per their terms).
    expect(before?.basemapKind).toBe("vector");
    expect(before?.basemapAttribution?.map((l) => l.label)).toEqual([
      "© OpenMapTiles",
      "OpenStreetMap contributors",
    ]);

    process.env.DEZFIL_SATELLITE_URL =
      "https://imagery.example/tiles/{z}/{y}/{x}?key=SECRET";
    process.env.DEZFIL_SATELLITE_ATTRIBUTION = "© Imagery Provider";
    try {
      updateMap(testAccountScope(), map.id, { basemap: "satellite" });
      const after = await getPublishedView(token, t0 + 31_000);
      expect(after?.basemapUrl).toBe("/api/basemaps/satellite");
      expect(after?.basemapKind).toBe("imagery");
      expect(after?.basemapAttribution?.[0]?.label).toBe(
        "© Imagery Provider",
      );
    } finally {
      delete process.env.DEZFIL_SATELLITE_URL;
      delete process.env.DEZFIL_SATELLITE_ATTRIBUTION;
    }
  });

  it("a custom style wins in both themes with its snapshot credit", async () => {
    process.env.DEZFIL_PUBLISH_FRESHNESS_S = "30";
    const map = await mapWithLayer();
    const { token } = publishMap(testAccountScope(), map.id);
    const t0 = 4_000_000;
    updateMap(testAccountScope(), map.id, {
      customBasemap: {
        url: "https://styles.example/dark.json",
        name: "Company dark",
        attribution: [{ label: "© Somebody", href: "https://somebody.test" }],
      },
    });
    const view = await getPublishedView(token, t0);
    // Custom wins outright: fixed URL in both themes, the saved snapshot
    // as credit — never the OpenFreeMap fallback — and the stored key
    // (Auto here) untouched underneath.
    expect(view?.basemapUrl).toBe("https://styles.example/dark.json");
    expect(view?.basemapForTheme).toBeNull();
    expect(view?.customBasemap?.name).toBe("Company dark");
    expect(view?.basemapAttribution).toEqual([
      { label: "© Somebody", href: "https://somebody.test" },
    ]);
    expect(view?.basemapKey).toBeNull();
    // Clearing reveals the stored key's own resolution again.
    updateMap(testAccountScope(), map.id, { customBasemap: null });
    const cleared = await getPublishedView(token, t0 + 31_000);
    expect(cleared?.customBasemap).toBeNull();
    expect(cleared?.basemapAttribution?.[0]?.label).toBe("© OpenMapTiles");
  });

  it("a metadata revision retires the cached legend corner", async () => {
    process.env.DEZFIL_PUBLISH_FRESHNESS_S = "30";
    const map = await mapWithLayer();
    const { token } = publishMap(testAccountScope(), map.id);
    const t0 = 5_000_000;
    expect((await getPublishedView(token, t0))?.legendCorner).toBeNull();

    updateMap(testAccountScope(), map.id, { legendCorner: "top-right" });
    const after = await getPublishedView(token, t0 + 1000);
    expect(after?.legendCorner).toBe("top-right");
  });

  it("popup fields and labels travel to published views", async () => {
    const map = await mapWithLayer();
    const { updateLayer } = await import("@/lib/layer-service");
    const { listLayers } = await import("@/lib/metadata/maps");
    const [layer] = listLayers(map.id);
    await updateLayer(testAccountScope(), layer.id, {
      popup: ["name"],
      style: {
        ...layer.style,
        label: {
          attribute: "name",
          size: 12,
          color: { r: 255, g: 255, b: 255, a: 1 },
          haloWidth: 1, haloColor: { r: 12, g: 16, b: 24, a: 0.8 },
        },
      },
    });
    const { token } = publishMap(testAccountScope(), map.id);
    const view = await getPublishedView(token, 5_000_000);
    expect(view?.layers[0].popup).toEqual(["name"]);
    expect(view?.layers[0].style.label?.attribute).toBe("name");
  });
});

describe("published-field projection", () => {
  async function wideMap() {
    const src = path.join(dir, "w.csv");
    await writeFile(
      src,
      "name,secret,riders,lon,lat\na,s1,10,1,2\nb,s2,20,3,4\n",
    );
    await ingestFile(testAccountScope(), src, "w.csv");
    const map = createMap(testAccountScope(), "wide");
    const layer = await createLayer(testAccountScope(), map.id, {
      name: "l",
      sql: "SELECT * FROM w",
    });
    return { map, layer };
  }

  const keysOf = (render: unknown): string[] =>
    Object.keys(
      (
        render as {
          geojson: { features: { properties: Record<string, unknown> }[] };
        }
      ).geojson.features[0].properties,
    );

  it("view payload carries exactly the explicit interaction fields", async () => {
    const { map, layer } = await wideMap();
    await updateLayer(testAccountScope(), layer.id, { tooltip: ["name"], popup: [] });
    const { token } = publishMap(testAccountScope(), map.id);
    const view = await getPublishedView(token, Date.now());
    // The hidden column is absent from the wire, not merely undisplayed.
    expect(keysOf(view?.layers[0].render)).toEqual(["name"]);
  });

  it("automatic tooltips publish what the builder shows — no more", async () => {
    const { map, layer } = await wideMap();
    const builder = await renderLayer(testAccountScope(), layer, undefined, { tileAccess: privateTileAccess(testAccountScope(), (layer).id) });
    const { token } = publishMap(testAccountScope(), map.id);
    const view = await getPublishedView(token, Date.now());
    expect(keysOf(view?.layers[0].render)).toEqual(keysOf(builder));
  });

  it("the override is the functional core plus exactly the listed fields", async () => {
    const { map, layer } = await wideMap();
    await updateLayer(testAccountScope(), layer.id, {
      tooltip: ["name", "secret"],
      publishedFields: ["riders"],
    });
    const { token } = publishMap(testAccountScope(), map.id);
    const view = await getPublishedView(token, Date.now());
    // Tooltip entries outside the effective set do not ship; the viewer
    // shows only what ships.
    expect(keysOf(view?.layers[0].render)).toEqual(["riders"]);
    // And the response never NAMES them either (round one): the
    // interaction lists are filtered through the effective set.
    expect(view?.layers[0].tooltip).toEqual([]);
  });

  it("the settle lane projects for its reader audience only", async () => {
    const { layer } = await wideMap();
    const clustered = await updateLayer(testAccountScope(), layer.id, {
      tooltip: ["name"],
      popup: [],
      viz: { type: "cluster", radiusPx: 64, color: "fixed", showCounts: true },
    });
    const published = {
      timeline: null,
      widgets: [],
      widgetsPublished: true,
    };
    const reader = await renderLayerWithSelections(testAccountScope(), clustered, [], undefined, {
      published,
    });
    expect(keysOf(reader)).toEqual(["name"]);
    // The builder's settle preview keeps the full row.
    const builder = await renderLayerWithSelections(testAccountScope(), clustered, []);
    expect(keysOf(builder)).toContain("secret");
  });

  it("aggregated layers are unchanged: computed columns only", async () => {
    const { map, layer } = await wideMap();
    await updateLayer(testAccountScope(), layer.id, {
      viz: { type: "hexbin", cellKm: 50, aggregate: { fn: "count" } },
    });
    const { token } = publishMap(testAccountScope(), map.id);
    const view = await getPublishedView(token, Date.now());
    // __anchor is the reserved label anchor for non-point cells — part of
    // the documented reserved presentation values, not data.
    expect(keysOf(view?.layers[0].render)).toEqual([
      "value",
      "count",
      "__anchor",
    ]);
  });

  it("the builder render still carries every column", async () => {
    const { layer } = await wideMap();
    const updated = await updateLayer(testAccountScope(), layer.id, {
      tooltip: ["name"],
      publishedFields: ["riders"],
    });
    expect(keysOf(await renderLayer(testAccountScope(), updated, undefined, { tileAccess: privateTileAccess(testAccountScope(), (updated).id) }))).toContain("secret");
  });

  it("an errored render ships explicit interaction lists empty (round two)", async () => {
    const { map, layer } = await wideMap();
    await updateLayer(testAccountScope(), layer.id, {
      tooltip: ["name", "secret"],
      publishedFields: ["riders"],
    });
    // Break the layer underneath, bypassing validation — the published
    // view keeps rendering, the layer errors, and the config must not
    // name columns the (absent) wire never carried.
    const { updateLayerFields } = await import("@/lib/metadata/maps");
    updateLayerFields(layer.id, { sql: "SELECT * FROM vanished" });
    const { token } = publishMap(testAccountScope(), map.id);
    const view = await getPublishedView(token, Date.now());
    expect(view?.layers[0].render.ok).toBe(false);
    expect(view?.layers[0].tooltip).toEqual([]);
  });

  it("a published arc ships no endpoint column names (round two)", async () => {
    const src = path.join(dir, "flows.csv");
    await writeFile(
      src,
      "origin_lon,origin_lat,dest_lon,dest_lat,riders\n1,2,3,4,10\n5,6,7,8,20\n",
    );
    await ingestFile(testAccountScope(), src, "flows.csv");
    const map = createMap(testAccountScope(), "flows");
    const layer = await createLayer(testAccountScope(), map.id, {
      name: "l",
      sql: "SELECT * FROM flows",
    });
    await updateLayer(testAccountScope(), layer.id, {
      viz: {
        type: "arc",
        origin: { kind: "lonlat", lon: "origin_lon", lat: "origin_lat" },
        dest: { kind: "lonlat", lon: "dest_lon", lat: "dest_lat" },
        height: 0.6,
      },
      tooltip: ["riders"],
      popup: [],
    });
    const { token } = publishMap(testAccountScope(), map.id);
    const view = await getPublishedView(token, Date.now());
    const viz = view?.layers[0].viz as {
      type: string;
      origin: unknown;
      dest: unknown;
    };
    expect(viz.type).toBe("arc");
    // The line geometry embodies the mapping; the column names stay off
    // the anonymous wire.
    expect(viz.origin).toBeNull();
    expect(viz.dest).toBeNull();

    // The custom icon markup, by contrast, IS the icon — it rides the
    // published viz whole, which is what lets the reader and the
    // exported image draw it with no asset resolution.
    await updateLayer(testAccountScope(), layer.id, {
      viz: {
        type: "icon",
        glyph: "marker",
        customSvg:
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><path d="M0 0h4v4z"/></svg>',
      },
    });
    const after = await getPublishedView(token, Date.now() + 40_000);
    const iconViz = after?.layers[0].viz as { customSvg?: string };
    expect(iconViz.customSvg).toContain("M0 0h4v4z");
    // __anchor is the reserved label anchor for non-point geometry — the
    // arc's line — part of the documented reserved presentation values.
    expect(keysOf(view?.layers[0].render)).toEqual(["riders", "__anchor"]);
  });

  it("a hidden layer ships no feature data; its widgets keep computing", async () => {
    const { map, layer } = await wideMap();
    updateMap(testAccountScope(), map.id, {
      widgets: [
        {
          id: "w1",
          type: "formula",
          layerId: layer.id,
          title: "Total riders",
          field: "riders",
          agg: "sum",
          aggField: null,
          unit: null,
          note: null,
          format: null,
          visible: true,
        },
      ],
    });
    await updateLayer(testAccountScope(), layer.id, { visible: false });
    const { token } = publishMap(testAccountScope(), map.id);
    const view = await getPublishedView(token, Date.now());
    // No entry at all: no rows, no attributes, no extent to frame.
    expect(view?.layers).toEqual([]);
    // The widget still ships and its aggregate still answers — hide the
    // geometry, keep the numbers.
    expect(view?.widgets.map((w) => w.id)).toEqual(["w1"]);
    const record = mapWithLayers(testAccountScope(), map.id);
    const values = await computeWidgetValues(testAccountScope(), record, record.layers, []);
    expect(values.widgets[0]).toMatchObject({ type: "formula", value: 30 });
  });

  it("a map published serves the derived projection on first read after upgrade", async () => {
    // A genuine earlier database: schema v19, a published map whose layer
    // hides a column from the tooltip — and, per the era, still published
    // it. No author action happens after the upgrade.
    const { default: Database } = await import("better-sqlite3");
    const { MIGRATIONS } = await import("@/lib/metadata/db");
    const { defaultStyle } = await import("@/lib/style/defaults");
    const { mkdir } = await import("node:fs/promises");
    // A data directory of its own — the suite's default one has already
    // been opened by the current schema.
    const dataDir = path.join(dir, "legacy-data");
    await mkdir(dataDir, { recursive: true });
    closeMetadataDb();
    resetQueryInstance();
    process.env.DEZFIL_DATA_DIR = dataDir;
    const raw = new Database(path.join(dataDir, "metadata.sqlite"));
    raw.pragma("journal_mode = WAL");
    for (const migration of MIGRATIONS.slice(0, 19)) raw.exec(migration);
    raw.pragma("user_version = 19");
    const now = new Date().toISOString();
    const legacyToken = "legacymigrationtoken00";
    raw
      .prepare(
        `INSERT INTO maps (id, name, view_lng, view_lat, view_zoom, publish_token, published_at, created_at, updated_at)
         VALUES (?, ?, 0, 20, 1.4, ?, ?, ?, ?)`,
      )
      .run("legacy-map", "Legacy", legacyToken, now, now, now);
    raw
      .prepare(
        `INSERT INTO layers (id, map_id, name, sql, style, visible, tooltip, popup, in_legend, ordinal, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, 1, 0, ?, ?)`,
      )
      .run(
        "legacy-layer",
        "legacy-map",
        "Legacy layer",
        "SELECT * FROM w",
        JSON.stringify(defaultStyle("POINT")),
        JSON.stringify(["name"]),
        JSON.stringify([]),
        now,
        now,
      );
    raw.close();

    // The first app-path open migrates v19 → v20; the ingest registers the
    // table the legacy layer reads.
    const src = path.join(dir, "w.csv");
    await writeFile(
      src,
      "name,secret,riders,lon,lat\na,s1,10,1,2\nb,s2,20,3,4\n",
    );
    await ingestFile(testAccountScope(), src, "w.csv");

    const { getLayer } = await import("@/lib/metadata/maps");
    expect(getLayer("legacy-layer")?.publishedFields).toBeNull();

    const view = await getPublishedView(legacyToken, Date.now());
    const properties = (
      view?.layers[0].render as {
        geojson: { features: { properties: Record<string, unknown> }[] };
      }
    ).geojson.features[0].properties;
    // The narrowing is the migration: the tooltip's field ships, the
    // hidden columns no longer do.
    expect(Object.keys(properties)).toEqual(["name"]);
  });

  it("a timeline docked to a hidden layer degrades away", async () => {
    const src = path.join(dir, "t.csv");
    await writeFile(
      src,
      "name,seen,lon,lat\na,2021-01-01T00:00:00Z,1,2\nb,2021-06-01T00:00:00Z,3,4\n",
    );
    await ingestFile(testAccountScope(), src, "t.csv");
    const map = createMap(testAccountScope(), "timed");
    const layer = await createLayer(testAccountScope(), map.id, {
      name: "l",
      sql: "SELECT * FROM t",
    });
    await updateLayer(testAccountScope(), layer.id, {
      filters: [{ field: "seen", kind: "timerange", min: null, max: null }],
    });
    updateMap(testAccountScope(), map.id, {
      timeline: { layerId: layer.id, field: "seen", speed: 1 },
    });
    const { token } = publishMap(testAccountScope(), map.id);
    expect((await getPublishedView(token, Date.now()))?.timeline).not.toBeNull();

    await updateLayer(testAccountScope(), layer.id, { visible: false });
    expect((await getPublishedView(token, Date.now()))?.timeline).toBeNull();
  });
});

describe("rate limit", () => {
  it("allows a burst then blocks within the window", () => {
    process.env.DEZFIL_PUBLIC_RATE_LIMIT = "3";
    const now = 5_000_000;
    expect(rateLimit("k", now)).toBe(true);
    expect(rateLimit("k", now)).toBe(true);
    expect(rateLimit("k", now)).toBe(true);
    expect(rateLimit("k", now)).toBe(false);
    // new window
    expect(rateLimit("k", now + 11_000)).toBe(true);
    delete process.env.DEZFIL_PUBLIC_RATE_LIMIT;
  });
});

describe("published error disclosure", () => {
  it("an errored view-payload envelope carries the catalogue sentence; the builder keeps the raw diagnostic", async () => {
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(testAccountScope(), map.id, {
      name: "l",
      sql: "SELECT * FROM s",
    });
    const { token } = publishMap(testAccountScope(), map.id);
    await removeTable(testAccountScope(), "s");
    resetPublishCache();

    const view = await getPublishedView(token, Date.now());
    expect(view).not.toBeNull();
    const render = view!.layers[0].render;
    expect(render.ok).toBe(false);
    // Exactly the documented sentence for the code — and no engine text
    // anywhere in the whole payload.
    expect(render.error!.message).toBe(publishedMessage(render.error!.code));
    expect(JSON.stringify(view)).not.toMatch(
      /does not exist|Catalog|Binder|LINE \d/,
    );

    // The author's own surface keeps the engine's diagnostic — the
    // documented carve-out on the authenticated-equivalent boundary.
    const raw = await renderLayer(testAccountScope(), layer, undefined, { tileAccess: privateTileAccess(testAccountScope(), (layer).id) });
    expect(raw.ok).toBe(false);
    expect(raw.error!.message).toMatch(/does not exist|Catalog/i);
    expect(raw.error!.message).not.toBe(render.error!.message);
  });

  it("a failed tile build's envelope substitutes to its documented sentence at the boundary", () => {
    const sanitized = sanitizePublishedRender({
      layerId: "x",
      ok: false,
      error: {
        code: "tile_build_failed",
        message:
          "Preparing tiles failed: tippecanoe exited 137 writing /data/tiles/x.pmtiles",
      },
    });
    expect(sanitized.error!.message).toBe(
      publishedMessage("tile_build_failed"),
    );
    expect(JSON.stringify(sanitized)).not.toContain("tippecanoe");
    expect(JSON.stringify(sanitized)).not.toContain("/data");
  });

  it("an ok envelope passes the boundary untouched", () => {
    const ok = { layerId: "x", ok: true, mode: "inline" as const, geojson: {} };
    expect(sanitizePublishedRender(ok)).toBe(ok);
  });
});

describe("published theme", () => {
  it("a first publication with no stated mode reads dark", async () => {
    const map = await mapWithLayer();
    const { token } = publishMap(testAccountScope(), map.id);
    const view = await getPublishedView(token, Date.now());
    expect(view!.theme).toBe("dark");
  });

  it("a stated light mode is captured and resolves the Auto basemap light", async () => {
    const map = await mapWithLayer();
    const { token } = publishMap(testAccountScope(), map.id, { theme: "light" });
    const view = await getPublishedView(token, Date.now());
    expect(view!.theme).toBe("light");
    expect(view!.basemapForTheme).not.toBeNull();
    expect(view!.basemapUrl).toBe(view!.basemapForTheme!.light);
    expect(view!.basemapForTheme!.dark).not.toBe(view!.basemapForTheme!.light);
  });

  it("a stated mode on an active publication updates in place: same token, cached payload retired", async () => {
    const map = await mapWithLayer();
    const first = publishMap(testAccountScope(), map.id, { theme: "dark" });
    const before = await getPublishedView(first.token, Date.now());
    expect(before!.theme).toBe("dark");
    const second = publishMap(testAccountScope(), map.id, { theme: "light" });
    expect(second.token).toBe(first.token);
    // Same freshness window: the revision moved, so the cache misses.
    const after = await getPublishedView(first.token, Date.now());
    expect(after!.theme).toBe("light");
  });

  it("an omitted mode on an active publication changes nothing", async () => {
    const map = await mapWithLayer();
    const { token } = publishMap(testAccountScope(), map.id, { theme: "light" });
    publishMap(testAccountScope(), map.id);
    const view = await getPublishedView(token, Date.now());
    expect(view!.theme).toBe("light");
  });

  it("unpublish clears the default; the next publication captures fresh", async () => {
    const map = await mapWithLayer();
    publishMap(testAccountScope(), map.id, { theme: "light" });
    unpublishMap(testAccountScope(), map.id);
    const { token } = publishMap(testAccountScope(), map.id);
    const view = await getPublishedView(token, Date.now());
    expect(view!.theme).toBe("dark");
  });

  it("an ordinary map edit does not change the active publication's default", async () => {
    const map = await mapWithLayer();
    const { token } = publishMap(testAccountScope(), map.id, { theme: "light" });
    updateMap(testAccountScope(), map.id, { name: "renamed" });
    const view = await getPublishedView(token, Date.now());
    expect(view!.theme).toBe("light");
  });

  it("an explicit basemap never follows the theme", async () => {
    const map = await mapWithLayer();
    updateMap(testAccountScope(), map.id, { basemap: "streets" });
    const { token } = publishMap(testAccountScope(), map.id, { theme: "light" });
    const view = await getPublishedView(token, Date.now());
    expect(view!.theme).toBe("light");
    expect(view!.basemapForTheme).toBeNull();
    expect(view!.basemapUrl).toContain("liberty");
  });

  it("a deployment override pins Auto in both themes", async () => {
    process.env.DEZFIL_BASEMAP_URL = "https://example.test/pinned.json";
    try {
      const map = await mapWithLayer();
      const { token } = publishMap(testAccountScope(), map.id, { theme: "light" });
      const view = await getPublishedView(token, Date.now());
      expect(view!.basemapForTheme).toBeNull();
      expect(view!.basemapUrl).toBe("https://example.test/pinned.json");
    } finally {
      delete process.env.DEZFIL_BASEMAP_URL;
    }
  });

  it("a duplicated map carries no publication default", async () => {
    const map = await mapWithLayer();
    publishMap(testAccountScope(), map.id, { theme: "light" });
    const copy = duplicateMap(testAccountScope(), map.id);
    const { token } = publishMap(testAccountScope(), copy.id);
    const view = await getPublishedView(token, Date.now());
    expect(view!.theme).toBe("dark");
  });

  it("a publication with no stored default (pre-) reads dark", async () => {
    const map = await mapWithLayer();
    const { token } = publishMap(testAccountScope(), map.id, { theme: "light" });
    // Simulate the earlier row state the migration leaves behind.
    setPublishedTheme(map.id, null);
    const view = await getPublishedView(token, Date.now());
    expect(view!.theme).toBe("dark");
  });
});
