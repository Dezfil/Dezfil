import { testAccountScope, testAccountRequest } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { resumeAssistant, runAssistant, type AssistantEvent } from "./loop";
import { PendingActionStore } from "./pending";
import { stubProvider, type ScriptEntry } from "./providers/stub";
import { createMap, requireMap } from "@/lib/map-service";
import { createLayer, requireLayer } from "@/lib/layer-service";

import { GET as mapsGet } from "@/app/api/maps/route";
import { GET as tablesGet } from "@/app/api/tables/route";
import { dispatchAssistantJourney as dispatch, assistantJourneyFetch } from "../../../test-support/assistant-loopback";

/**
 * The assistant exit-gate journey and the grounding/honesty + safety
 * acceptance criteria, driven end to end: scripted model → bounded loop
 * → OpenAPI-derived tools → the product's own real route handlers →
 * real DuckDB. Only the model is a stub.
 */

let dir: string;

// This hook runs two real ingests per case, and per-case isolation is
// load-bearing (cases assert absolute map counts and drive undo history),
// so the seeding stays per-test. Vitest's default 10 s hook budget is not
// sized for that on a loaded CI runner: the merge commit ran the unit
// suite at ~4x its local time and two attempts of this hook crossed 10 s,
// reddening main with no regression behind it. Locally the hook
// takes ~10 ms (worst observed 143 ms, the cold first run), so the CI
// overruns were runner stalls measured in seconds, not a slow hook — the
// budget must absorb those stalls, and 60 s does while a genuine hang
// still fails well inside the job's patience.
beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();

  // Seed two spatial tables: stations and parks (points), enough to drive a
  // "parks near a station" style analytical query.
  const stations = path.join(dir, "stations.csv");
  await writeFile(stations, "name,lon,lat\nalexanderplatz,13.41,52.52\nzoo,13.33,52.51\n");
  await ingestFile(testAccountScope(), stations, "stations.csv");
  const parks = path.join(dir, "parks.csv");
  await writeFile(
    parks,
    "name,lon,lat,area_ha\ntiergarten,13.35,52.514,210\nmonbijou,13.40,52.524,3\n",
  );
  await ingestFile(testAccountScope(), parks, "parks.csv");

  vi.stubGlobal("fetch", assistantJourneyFetch);
}, 60_000);

afterEach(async () => {
  vi.unstubAllGlobals();
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

async function drive(script: ScriptEntry[], message: string) {
  const provider = stubProvider(script);
  const store = new PendingActionStore();
  const deps = { baseUrl: "http://127.0.0.1:3000", pending: store };
  const events: AssistantEvent[] = [];
  for await (const event of runAssistant(
    provider,
    { message, history: [] },
    deps,
  )) {
    events.push(event);
  }
  // Resolve a raised confirmation the way the endpoint does: claim the
  // parked run and re-enter it — the same exchange, never a fresh one.
  const resume = async (pendingId: string, approved: boolean) => {
    const parked = store.claim(pendingId, approved ? "approved" : "declined");
    if (!parked) throw new Error(`No parked run for ${pendingId}`);
    const resumed: AssistantEvent[] = [];
    for await (const event of resumeAssistant(parked, approved, deps)) {
      resumed.push(event);
    }
    return resumed;
  };
  return { events, recording: provider.recording, resume };
}

function pendingIdOf(events: AssistantEvent[]): string {
  const confirm = events.find((e) => e.type === "confirm_required");
  if (!confirm || confirm.type !== "confirm_required") {
    throw new Error("No confirmation was raised");
  }
  return confirm.id;
}

const call = (name: string, args: Record<string, unknown>, id = "c1") => ({
  id,
  name,
  args,
});

describe("assistant journey (exit gate)", () => {
  it("builds a styled layer of parks near a station without the user writing SQL", async () => {
    const sql =
      "SELECT DISTINCT p.name, p.geometry FROM parks p, stations s " +
      "WHERE ST_DWithin(p.geometry, s.geometry, 0.05)";
    const { events } = await drive(
      [
        {
          text: "First I'll see what tables exist.",
          toolCalls: [call("list_tables", {}, "t1")],
        },
        {
          text: "I'll create a map to hold the result.",
          toolCalls: [call("create_map", { name: "Parks near stations" }, "t2")],
        },
        // Reads the real map id from the create_map result, like a model would.
        (outcomes) => {
          const mapId = JSON.parse(outcomes[0].body).id as string;
          return {
            text: `Here is the SQL joining parks to nearby stations:\n${sql}`,
            toolCalls: [
              call("create_layer", { id: mapId, name: "Nearby parks", sql }, "t3"),
            ],
          };
        },
        { text: "Done — the layer renders the matching parks.", toolCalls: [] },
      ],
      "show me all parks within ~1km of a station",
    );

    // The tools ran against the real API and produced a real map + layer.
    const created = events.find(
      (e) => e.type === "tool_result" && e.tool === "create_map",
    );
    expect(created).toMatchObject({ ok: true });
    const mapId = (created as { body: { id: string } }).body.id;

    const layer = events.find(
      (e) => e.type === "tool_result" && e.tool === "create_layer",
    ) as { ok: boolean; body: { id: string; sql: string; mapId: string } };
    expect(layer.ok).toBe(true);
    expect(layer.body.mapId).toBe(mapId);
    // SQL is the source of truth — the layer stores exactly what was run.
    expect(layer.body.sql).toBe(sql);

    // The assistant showed the SQL to the user.
    const shown = events.filter((e) => e.type === "message").map((e) => (e as { text: string }).text);
    expect(shown.some((t) => t.includes("ST_DWithin"))).toBe(true);

    // The layer actually renders the correct result (tiergarten + monbijou
    // are both within ~1km of a station; the layer is non-empty and valid).
    const render = await dispatch(
      new Request(`http://127.0.0.1:3000/api/layers/${layer.body.id}/render`),
    );
    const rendered = await render.json();
    expect(rendered.ok).toBe(true);
    expect(rendered.featureCount).toBeGreaterThan(0);
  });

  it("produces an aggregated, filtered layer from a plain-English request", async () => {
    const { events } = await drive(
      [
        {
          text: "I'll put the parks on a map first.",
          toolCalls: [call("create_map", { name: "Park density" }, "t1")],
        },
        (outcomes) => {
          const mapId = JSON.parse(outcomes[0].body).id as string;
          return {
            text: "Adding the parks layer.",
            toolCalls: [
              call(
                "create_layer",
                { id: mapId, name: "Parks", sql: "SELECT name, area_ha, geometry FROM parks" },
                "t2",
              ),
            ],
          };
        },
        (outcomes) => {
          const layerId = JSON.parse(outcomes[0].body).id as string;
          return {
            text: "Switching to hexagons and keeping only the large parks.",
            toolCalls: [
              call(
                "update_layer",
                {
                  id: layerId,
                  viz: { type: "hexbin", cellKm: 1.22, aggregate: { fn: "count" } },
                  filters: [{ field: "area_ha", kind: "range", min: 100, max: null }],
                },
                "t3",
              ),
            ],
          };
        },
        { text: "Done — hexagon bins over the large parks.", toolCalls: [] },
      ],
      "show the parks as hexagons, but only the ones bigger than 100 hectares",
    );

    const updated = events.find(
      (e) => e.type === "tool_result" && e.tool === "update_layer",
    ) as { ok: boolean; body: { id: string; viz: { fill?: { type: string; attribute?: string } } } };
    expect(updated.ok).toBe(true);
    // The server classified the cells over the aggregate value automatically.
    expect(updated.body.viz.fill).toMatchObject({ type: "quantile", attribute: "value" });

    // The rendered result is the filtered aggregation: one park ≥ 100 ha →
    // one cell with count 1.
    const render = await dispatch(
      new Request(`http://127.0.0.1:3000/api/layers/${updated.body.id}/render`),
    );
    const rendered = await render.json();
    expect(rendered.ok).toBe(true);
    expect(rendered.featureCount).toBe(1);
    const feature = rendered.geojson.features[0];
    expect(feature.properties.count).toBe(1);
    expect(feature.geometry.type).toBe("Polygon");
  });

  it("sizes and outlines a layer by attribute from a plain-English request", async () => {
    let layer: { id: string; style: Record<string, unknown> };
    let scale: Record<string, unknown>;
    const { events } = await drive(
      [
        {
          text: "I'll put the parks on a map.",
          toolCalls: [call("create_map", { name: "Parks by size" }, "t1")],
        },
        (outcomes) => {
          const mapId = JSON.parse(outcomes[0].body).id as string;
          return {
            text: "Adding the parks layer.",
            toolCalls: [
              call(
                "create_layer",
                { id: mapId, name: "Parks", sql: "SELECT name, area_ha, geometry FROM parks" },
                "t2",
              ),
            ],
          };
        },
        (outcomes) => {
          layer = JSON.parse(outcomes[0].body);
          return {
            text: "Resolving the size scale over the park areas.",
            toolCalls: [
              call("compute_scale", { id: layer.id, attribute: "area_ha", range: [4, 28] }, "t3"),
            ],
          };
        },
        (outcomes) => {
          scale = JSON.parse(outcomes[0].body);
          return {
            text: "Coloring the outline by park name.",
            toolCalls: [
              call("compute_fill", { id: layer.id, attribute: "name", method: "categorical" }, "t4"),
            ],
          };
        },
        (outcomes) => {
          const paint = JSON.parse(outcomes[0].body);
          return {
            text: "Applying both channels to the style.",
            toolCalls: [
              call(
                "update_layer",
                {
                  id: layer.id,
                  style: { ...layer.style, pointRadiusBy: scale, strokeBy: paint },
                },
                "t5",
              ),
            ],
          };
        },
        { text: "The parks are sized by area and outlined by name.", toolCalls: [] },
      ],
      "size the parks by their area and color their outlines by name",
    );

    const updated = events.find(
      (e) => e.type === "tool_result" && e.tool === "update_layer",
    ) as {
      ok: boolean;
      body: {
        style: {
          pointRadiusBy?: { attribute: string; domain: number[]; range: number[] };
          strokeBy?: { type: string; attribute: string };
        };
      };
    };
    expect(updated.ok).toBe(true);
    // The scale's domain was resolved server-side from the real data.
    expect(updated.body.style.pointRadiusBy).toMatchObject({
      attribute: "area_ha",
      domain: [3, 210],
      range: [4, 28],
    });
    expect(updated.body.style.strokeBy).toMatchObject({
      type: "categorical",
      attribute: "name",
    });
  });

  it("styles a layer with a standard palette named in plain English", async () => {
    let layer: { id: string; style: Record<string, unknown> };
    const { events } = await drive(
      [
        {
          text: "I'll map the parks first.",
          toolCalls: [call("create_map", { name: "Parks by area" }, "t1")],
        },
        (outcomes) => {
          const mapId = JSON.parse(outcomes[0].body).id as string;
          return {
            text: "Adding the parks layer.",
            toolCalls: [
              call(
                "create_layer",
                { id: mapId, name: "Parks", sql: "SELECT name, area_ha, geometry FROM parks" },
                "t2",
              ),
            ],
          };
        },
        (outcomes) => {
          layer = JSON.parse(outcomes[0].body);
          return {
            text: "Classifying park area on the viridis ramp.",
            toolCalls: [
              call(
                "compute_fill",
                { id: layer.id, attribute: "area_ha", method: "quantile", palette: "viridis" },
                "t3",
              ),
            ],
          };
        },
        (outcomes) => {
          const paint = JSON.parse(outcomes[0].body);
          return {
            text: "Applying the fill.",
            toolCalls: [
              call(
                "update_layer",
                { id: layer.id, style: { ...layer.style, fill: paint } },
                "t4",
              ),
            ],
          };
        },
        { text: "The parks are colored by area on the viridis ramp.", toolCalls: [] },
      ],
      "color the parks by area using the viridis colormap",
    );

    const updated = events.find(
      (e) => e.type === "tool_result" && e.tool === "update_layer",
    ) as {
      ok: boolean;
      body: {
        style: {
          fill: {
            type: string;
            palette: string;
            colors: { r: number; g: number; b: number; a: number }[];
          };
        };
      };
    };
    expect(updated.ok).toBe(true);
    const fill = updated.body.style.fill;
    expect(fill).toMatchObject({ type: "quantile", palette: "viridis" });
    // The ramp's ends are matplotlib's published viridis extremes — the
    // catalogue resolved a palette that didn't exist before 0009.
    expect(fill.colors[0]).toMatchObject({ r: 68, g: 1, b: 84 });
    expect(fill.colors.at(-1)).toMatchObject({ r: 253, g: 231, b: 37 });
  });

  it("adds a map note from a plain-English request", async () => {
    const { events } = await drive(
      [
        {
          text: "Creating the map first.",
          toolCalls: [call("create_map", { name: "Parks" }, "t1")],
        },
        (outcomes) => {
          const mapId = JSON.parse(outcomes[0].body).id as string;
          return {
            text: "Adding the source credit as a note, top left.",
            toolCalls: [
              call(
                "update_map",
                {
                  id: mapId,
                  // Notes are widgets — the agent surface too.
                  widgets: [
                    {
                      id: "note-1",
                      type: "note",
                      layerId: null,
                      title: "Sources",
                      field: null,
                      agg: "count",
                      aggField: null,
                      unit: null,
                      note: "Data © [OpenStreetMap](https://osm.org) contributors",
                      format: null,
                      visible: true,
                    },
                  ],
                },
                "t2",
              ),
            ],
          };
        },
        { text: "Done — the note credits the data source.", toolCalls: [] },
      ],
      "add a note crediting the data source",
    );

    const updated = events.find(
      (e) => e.type === "tool_result" && e.tool === "update_map",
    ) as {
      ok: boolean;
      body: { widgets: { type: string; title: string; note: string }[] };
    };
    expect(updated.ok).toBe(true);
    expect(updated.body.widgets).toEqual([
      expect.objectContaining({
        type: "note",
        title: "Sources",
        note: "Data © [OpenStreetMap](https://osm.org) contributors",
      }),
    ]);
  });

  it("quiets the basemap from a plain-English request", async () => {
    const { events } = await drive(
      [
        {
          text: "Creating the map first.",
          toolCalls: [call("create_map", { name: "Quiet" }, "t1")],
        },
        (outcomes) => {
          const mapId = JSON.parse(outcomes[0].body).id as string;
          return {
            text: "Hiding the basemap labels and roads.",
            toolCalls: [
              call(
                "update_map",
                {
                  id: mapId,
                  basemapLayers: { labels: false, roads: false },
                },
                "t2",
              ),
            ],
          };
        },
        {
          text: "Done — labels and roads are hidden on the basemap.",
          toolCalls: [],
        },
      ],
      "hide the basemap labels and roads so my data stands out",
    );

    const updated = events.find(
      (e) => e.type === "tool_result" && e.tool === "update_map",
    ) as {
      ok: boolean;
      body: { basemapLayers: Record<string, boolean> | null };
    };
    expect(updated.ok).toBe(true);
    expect(updated.body.basemapLayers).toEqual({ labels: false, roads: false });
  });

  it("switches a map to satellite from plain English", async () => {
    const { events } = await drive(
      [
        {
          text: "Creating the map first.",
          toolCalls: [call("create_map", { name: "Aerial" }, "t1")],
        },
        (outcomes) => {
          const mapId = JSON.parse(outcomes[0].body).id as string;
          return {
            text: "Switching the basemap to satellite imagery.",
            toolCalls: [
              call("update_map", { id: mapId, basemap: "satellite" }, "t2"),
            ],
          };
        },
        {
          text: "Done — the map now shows satellite imagery.",
          toolCalls: [],
        },
      ],
      "switch this map to satellite",
    );

    const updated = events.find(
      (e) => e.type === "tool_result" && e.tool === "update_map",
    ) as {
      ok: boolean;
      body: { basemap: string | null };
    };
    expect(updated.ok).toBe(true);
    expect(updated.body.basemap).toBe("satellite");
  });

  it("moves the legend and hides a variable name from plain English", async () => {
    let mapId = "";
    const { events } = await drive(
      [
        {
          text: "Creating the map and a layer first.",
          toolCalls: [call("create_map", { name: "Tidy" }, "t1")],
        },
        (outcomes) => {
          mapId = JSON.parse(outcomes[0].body).id as string;
          return {
            text: "Adding the parks layer.",
            toolCalls: [
              call(
                "create_layer",
                { id: mapId, sql: "SELECT * FROM parks" },
                "t2",
              ),
            ],
          };
        },
        (outcomes) => {
          const layerId = JSON.parse(outcomes[0].body).id as string;
          return {
            text: "Moving the legend top right and hiding the fill variable.",
            toolCalls: [
              call("update_map", { id: mapId, legendCorner: "top-right" }, "t3"),
              call(
                "update_layer",
                { id: layerId, legendAttrs: { fill: null } },
                "t4",
              ),
            ],
          };
        },
        {
          text: "Done — legend top right, variable name hidden.",
          toolCalls: [],
        },
      ],
      "put the legend in the top right and hide the fill variable name",
    );

    const mapResult = events.find(
      (e) => e.type === "tool_result" && e.tool === "update_map",
    ) as { ok: boolean; body: { legendCorner: string | null } };
    expect(mapResult.ok).toBe(true);
    expect(mapResult.body.legendCorner).toBe("top-right");

    const layerResult = events.find(
      (e) => e.type === "tool_result" && e.tool === "update_layer",
    ) as { ok: boolean; body: { legendAttrs: Record<string, unknown> | null } };
    expect(layerResult.ok).toBe(true);
    expect(layerResult.body.legendAttrs).toEqual({ fill: null });
  });

  it("labels a layer and sets pop-up fields from plain English", async () => {
    let mapId = "";
    const { events } = await drive(
      [
        {
          text: "Creating the map first.",
          toolCalls: [call("create_map", { name: "Named stations" }, "t1")],
        },
        (outcomes) => {
          mapId = JSON.parse(outcomes[0].body).id as string;
          return {
            text: "Adding the stations layer.",
            toolCalls: [
              call(
                "create_layer",
                { id: mapId, sql: "SELECT * FROM stations" },
                "t2",
              ),
            ],
          };
        },
        (outcomes) => {
          const layer = JSON.parse(outcomes[0].body) as {
            id: string;
            style: Record<string, unknown>;
          };
          return {
            text: "Labeling each station by its name; the pop-up shows the name too.",
            toolCalls: [
              call(
                "update_layer",
                {
                  id: layer.id,
                  style: {
                    ...layer.style,
                    label: {
                      attribute: "name",
                      size: 14,
                      color: { r: 255, g: 255, b: 255, a: 1 },
                      haloWidth: 1, haloColor: { r: 12, g: 16, b: 24, a: 0.8 },
                    },
                  },
                  popup: ["name"],
                },
                "t3",
              ),
            ],
          };
        },
        {
          text: "Done — stations are labeled by name.",
          toolCalls: [],
        },
      ],
      "label the stations by their name",
    );

    const layerResult = events.find(
      (e) => e.type === "tool_result" && e.tool === "update_layer",
    ) as {
      ok: boolean;
      body: {
        style: { label?: { attribute?: string; haloWidth: number } };
        popup: string[] | null;
      };
    };
    expect(layerResult.ok).toBe(true);
    expect(layerResult.body.style.label?.attribute).toBe("name");
    expect(layerResult.body.style.label?.haloWidth).toBe(1);
    expect(layerResult.body.popup).toEqual(["name"]);
  });

  it("sets custom class boundaries from plain English", async () => {
    let mapId = "";
    let layerId = "";
    const { events } = await drive(
      [
        {
          text: "Creating the map first.",
          toolCalls: [call("create_map", { name: "Custom classes" }, "t1")],
        },
        (outcomes) => {
          mapId = JSON.parse(outcomes[0].body).id as string;
          return {
            text: "Adding the parks layer.",
            toolCalls: [
              call(
                "create_layer",
                { id: mapId, sql: "SELECT * FROM parks" },
                "t2",
              ),
            ],
          };
        },
        (outcomes) => {
          const layer = JSON.parse(outcomes[0].body) as { id: string };
          layerId = layer.id;
          return {
            text: "Classifying by area first.",
            toolCalls: [
              call(
                "compute_fill",
                { id: layerId, attribute: "area_ha", method: "quantile" },
                "t3",
              ),
            ],
          };
        },
        (outcomes) => {
          const fill = JSON.parse(outcomes[0].body) as {
            breaks: number[];
          };
          return {
            text: "Setting the top class to start at 200 hectares.",
            toolCalls: [
              call(
                "update_layer",
                {
                  id: layerId,
                  style: {
                    fill: {
                      ...fill,
                      method: "custom",
                      baseMethod: "quantile",
                      breaks: fill.breaks.map((b, i) =>
                        i === fill.breaks.length - 1 ? 200 : b,
                      ),
                    },
                    fillOpacity: 1,
                    stroke: { r: 12, g: 16, b: 24, a: 0.85 },
                    strokeOpacity: 1,
                    strokeWidth: 1,
                    pointRadius: 5,
                    opacity: 1,
                  },
                },
                "t4",
              ),
            ],
          };
        },
        {
          text: "Done — the top class now starts at 200 ha.",
          toolCalls: [],
        },
      ],
      "make the top class start at 200",
    );

    const layerResult = events.find(
      (e) => e.type === "tool_result" && e.tool === "update_layer",
    ) as {
      ok: boolean;
      body: {
        style: {
          fill: { method?: string; baseMethod?: string; breaks: number[] };
        };
      };
    };
    expect(layerResult.ok).toBe(true);
    expect(layerResult.body.style.fill.method).toBe("custom");
    expect(layerResult.body.style.fill.baseMethod).toBe("quantile");
    expect(
      layerResult.body.style.fill.breaks[
        layerResult.body.style.fill.breaks.length - 1
      ],
    ).toBe(200);
  });

  it("undoes a whole assistant turn as one step", async () => {
    // State built ahead of the turn: a map with a visible layer on Auto.
    const map = createMap(testAccountScope(), "Undoable");
    const layer = await createLayer(testAccountScope(), map.id, {
      name: "Stations",
      sql: "SELECT name, geometry FROM stations",
    });

    // One turn, two edits — the loop stamps both with one group marker.
    await drive(
      [
        {
          text: "Hiding the layer and darkening the basemap.",
          toolCalls: [
            call("update_layer", { id: layer.id, visible: false }, "t1"),
            call("update_map", { id: map.id, basemap: "dark" }, "t2"),
          ],
        },
        { text: "Done — hidden, on a dark basemap.", toolCalls: [] },
      ],
      "hide the stations and make the basemap dark",
    );
    expect(requireLayer(testAccountScope(), layer.id).visible).toBe(false);
    expect(requireMap(testAccountScope(), map.id).basemap).toBe("dark");

    // "undo that" — one undo call reverts the whole turn.
    const { events } = await drive(
      [
        {
          text: "Undoing that change.",
          toolCalls: [call("undo_change", { id: map.id }, "t3")],
        },
        { text: "Done — both changes are reverted.", toolCalls: [] },
      ],
      "undo that",
    );
    const undone = events.find(
      (e) => e.type === "tool_result" && e.tool === "undo_change",
    ) as {
      ok: boolean;
      body: { history: { canUndo: boolean; canRedo: boolean } };
    };
    expect(undone.ok).toBe(true);
    expect(undone.body.history.canRedo).toBe(true);
    expect(requireLayer(testAccountScope(), layer.id).visible).toBe(true);
    expect(requireMap(testAccountScope(), map.id).basemap).toBeNull();
  });

  it("animates a map by a temporal field from plain English", async () => {
    // A temporal table just for this scene: trip pings with a TIMESTAMP.
    const pings = path.join(dir, "pings.csv");
    await writeFile(
      pings,
      [
        "name,lon,lat,seen",
        "a,13.41,52.52,2021-03-01 08:30:00",
        "b,13.40,52.523,2021-03-02 12:00:00",
      ].join("\n"),
    );
    await ingestFile(testAccountScope(), pings, "pings.csv");
    const map = createMap(testAccountScope(), "Trips");
    const layer = await createLayer(testAccountScope(), map.id, {
      name: "Pings",
      sql: "SELECT name, seen, geometry FROM pings",
    });

    // "animate this by seen": ensure the time filter, then dock the
    // timeline — two documented calls, one turn.
    await drive(
      [
        {
          text: "Adding a time filter on seen and docking the timeline.",
          toolCalls: [
            call(
              "update_layer",
              {
                id: layer.id,
                filters: [
                  { field: "seen", kind: "timerange", min: null, max: null },
                ],
              },
              "t1",
            ),
            call(
              "update_map",
              { id: map.id, timeline: { layerId: layer.id, field: "seen" } },
              "t2",
            ),
          ],
        },
        { text: "Done — the map now plays over seen.", toolCalls: [] },
      ],
      "animate this map by seen",
    );
    expect(requireLayer(testAccountScope(), layer.id).filters).toEqual([
      { field: "seen", kind: "timerange", min: null, max: null },
    ]);
    expect(requireMap(testAccountScope(), map.id).timeline).toEqual({
      layerId: layer.id,
      field: "seen",
      speed: 1,
    });
  });
});

describe("grounding & honesty", () => {
  it("answers a data question with a real query and reports what was run", async () => {
    const { events, recording } = await drive(
      [
        {
          text: "Let me count the parks.",
          toolCalls: [call("run_sql", { sql: "SELECT count(*) AS n FROM parks" })],
        },
        { text: "There are 2 parks. I ran: SELECT count(*) FROM parks.", toolCalls: [] },
      ],
      "how many parks are there?",
    );
    const result = events.find((e) => e.type === "tool_result") as {
      ok: boolean;
      body: { preview: { n: string }[] };
    };
    expect(result.ok).toBe(true);
    expect(Number(result.body.preview[0].n)).toBe(2);
    // The real query result was returned to the model, not fabricated.
    const outcome = recording.exchanges[0].outcomes[0][0];
    expect(Number(JSON.parse(outcome.body).preview[0].n)).toBe(2);
  });

  it("surfaces a nonexistent-table error so the model can answer honestly", async () => {
    const { events, recording } = await drive(
      [
        {
          text: "Checking that table.",
          toolCalls: [call("run_sql", { sql: "SELECT * FROM rivers" })],
        },
        {
          text: "There is no table called rivers. Available: parks, stations.",
          toolCalls: [],
        },
      ],
      "what's in the rivers table?",
    );
    const result = events.find((e) => e.type === "tool_result") as { ok: boolean };
    expect(result.ok).toBe(false);
    const outcome = recording.exchanges[0].outcomes[0][0];
    expect(outcome.isError).toBe(true);
    expect(JSON.parse(outcome.body).error.code).toBe("sql_error");
  });
});

describe("safety through the assistant", () => {
  it("cannot mutate data via SQL — the query API rejects it and data is intact", async () => {
    const { events, recording } = await drive(
      [
        {
          text: "Removing those rows.",
          toolCalls: [call("run_sql", { sql: "DELETE FROM parks" })],
        },
        { text: "I can't do that — the query engine is read-only.", toolCalls: [] },
      ],
      "delete all the parks rows",
    );

    const rejected = events.find((e) => e.type === "tool_result") as { ok: boolean };
    expect(rejected.ok).toBe(false);
    const outcome = recording.exchanges[0].outcomes[0][0];
    expect(JSON.parse(outcome.body).error.code).toBe("sql_rejected");

    // Data verifiably unchanged.
    const check = await dispatch(
      new Request("http://127.0.0.1:3000/api/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sql: "SELECT count(*) AS n FROM parks" }),
      }),
    );
    const body = await check.json();
    expect(Number(body.preview[0].n)).toBe(2);
  });

  it("a destructive tool pauses for confirmation before any state changes", async () => {
    const { events } = await drive(
      [
        {
          text: "I'll delete the parks table.",
          toolCalls: [call("delete_table", { name: "parks" }, "d1")],
        },
      ],
      "get rid of the parks table",
    );
    // Confirmation was requested; the table was never deleted.
    expect(events.some((e) => e.type === "confirm_required")).toBe(true);
    const list = await tablesGet(new Request("http://dezfil.test/api/tables"));
    const tables = (await list.json()) as { name: string }[];
    expect(tables.map((t) => t.name)).toContain("parks");
  });
});

describe("confirmation contract", () => {
  it("approval resumes the paused turn: created once, published once, one exchange", async () => {
    let mapId = "";
    const h = await drive(
      [
        {
          text: "Creating the map.",
          toolCalls: [call("create_map", { name: "Parks tour" }, "b1")],
        },
        (outcomes) => {
          mapId = (JSON.parse(outcomes[0].body) as { id: string }).id;
          return {
            text: "Publishing needs your go-ahead.",
            toolCalls: [call("publish_map", { id: mapId }, "b2")],
          };
        },
        { text: "Published — anyone with the link can view it.", toolCalls: [] },
      ],
      "create a map called Parks tour and publish it",
    );

    const confirm = h.events.find((e) => e.type === "confirm_required");
    expect(confirm).toMatchObject({ tool: "publish_map" });
    // Executed-equals-presented: the action shown is the created map's.
    if (confirm?.type === "confirm_required") {
      expect(confirm.args.id).toBe(mapId);
    }

    const resumed = await h.resume(pendingIdOf(h.events), true);

    // The pre-confirmation mutation exists exactly once — the audit's
    // reproduction made a second map here.
    const maps = (await (await mapsGet(testAccountRequest(new Request("http://dezfil.test/api/maps")))).json()) as { name: string }[];
    expect(maps.filter((m) => m.name === "Parks tour").length).toBe(1);
    expect(maps.length).toBe(1);

    // The gated action ran exactly once, and the model heard its real result.
    expect(
      resumed.filter((e) => e.type === "tool_call" && e.tool === "publish_map")
        .length,
    ).toBe(1);
    expect(resumed.find((e) => e.type === "tool_result")).toMatchObject({
      tool: "publish_map",
      ok: true,
    });
    expect(resumed.at(-1)).toEqual({ type: "done", reason: "end" });

    // One exchange for the whole turn: resumed, never restarted.
    expect(h.recording.exchanges.length).toBe(1);
    expect(h.recording.exchanges[0].outcomes.length).toBe(2);
  });

  it("an approved turn is one undo step across the pause", async () => {
    const map = createMap(testAccountScope(), "Voyage");
    const layer = await createLayer(testAccountScope(), map.id, {
      name: "Stations",
      sql: "SELECT name, geometry FROM stations",
    });

    const h = await drive(
      [
        {
          text: "Renaming the layer first.",
          toolCalls: [
            call("update_layer", { id: layer.id, name: "All stations" }, "u1"),
          ],
        },
        {
          text: "Publishing needs your go-ahead.",
          toolCalls: [call("publish_map", { id: map.id }, "u2")],
        },
        {
          text: "Published. Retitling the map to match.",
          toolCalls: [call("update_map", { id: map.id, name: "Voyage, live" }, "u3")],
        },
        { text: "All done.", toolCalls: [] },
      ],
      "rename the layer, publish, then retitle the map",
    );
    await h.resume(pendingIdOf(h.events), true);
    expect(requireLayer(testAccountScope(), layer.id).name).toBe("All stations");
    expect(requireMap(testAccountScope(), map.id).name).toBe("Voyage, live");

    // "undo that" — one undo reverts the edits before and after the pause.
    await drive(
      [
        {
          text: "Undoing that turn.",
          toolCalls: [call("undo_change", { id: map.id }, "u4")],
        },
        { text: "Reverted.", toolCalls: [] },
      ],
      "undo that",
    );
    expect(requireLayer(testAccountScope(), layer.id).name).toBe("Stations");
    expect(requireMap(testAccountScope(), map.id).name).toBe("Voyage");

    // …and one redo restores the whole turn.
    await drive(
      [
        {
          text: "Redoing it.",
          toolCalls: [call("redo_change", { id: map.id }, "u5")],
        },
        { text: "Restored.", toolCalls: [] },
      ],
      "redo that",
    );
    expect(requireLayer(testAccountScope(), layer.id).name).toBe("All stations");
    expect(requireMap(testAccountScope(), map.id).name).toBe("Voyage, live");
  });

  it("a declined action stays undone while the turn finishes gracefully", async () => {
    const h = await drive(
      [
        {
          text: "I'll delete the parks table.",
          toolCalls: [call("delete_table", { name: "parks" }, "dd1")],
        },
        { text: "Understood — keeping parks.", toolCalls: [] },
      ],
      "drop the parks table",
    );
    const resumed = await h.resume(pendingIdOf(h.events), false);

    const tables = (await (await tablesGet(new Request("http://dezfil.test/api/tables"))).json()) as { name: string }[];
    expect(tables.map((t) => t.name)).toContain("parks");
    // The model was told in the documented words and finished its turn.
    const note = h.recording.exchanges[0].outcomes[0][0];
    expect(JSON.parse(note.body).note).toContain("did not confirm");
    expect(
      resumed.some((e) => e.type === "message" && e.text.includes("keeping")),
    ).toBe(true);
    expect(resumed.at(-1)).toEqual({ type: "done", reason: "end" });
    expect(h.recording.exchanges.length).toBe(1);
  });
});
