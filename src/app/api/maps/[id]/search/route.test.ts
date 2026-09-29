import { testAccountRequest } from "@/lib/test-support/accounts";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "./route";
import { POINTS_VIZ, type LayerViz } from "@/lib/viz";

/** Aggregated for isAggregated's purposes; the route never reads deeper. */
const HEXBIN_VIZ = { type: "hexbin" } as unknown as LayerViz;

/** The route's composition, over mocked seams: the metadata read and the
 * engine-backed value scan (itself engine-tested in value-search.test). */

const searchValues = vi.hoisted(() => vi.fn());
vi.mock("@/lib/search/value-search", () => ({ searchValues }));

const mapWithLayers = vi.hoisted(() => vi.fn());
vi.mock("@/lib/map-service", () => ({ mapWithLayers }));

const layer = (over: Record<string, unknown>) => ({
  id: "l1",
  name: "Stations",
  sql: "SELECT 1",
  visible: true,
  viz: POINTS_VIZ,
  filters: [],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  searchValues.mockResolvedValue([]);
  mapWithLayers.mockReturnValue({
    id: "m1",
    layers: [
      layer({}),
      layer({ id: "l2", name: "Hidden Stations", visible: false }),
      layer({ id: "l3", name: "Station Bins", viz: HEXBIN_VIZ }),
    ],
  });
});

const get = (query: string) =>
  GET(testAccountRequest(new Request(`http://test/api/maps/m1/search?${query}`)), {
    params: Promise.resolve({ id: "m1" }),
  });

describe("GET /api/maps/[id]/search", () => {
  it("answers matching visible layer names with viz context, hidden ones never", async () => {
    const body = await (await get("q=station")).json();
    expect(body.layers).toEqual([
      { layerId: "l1", name: "Stations", viz: "points" },
      { layerId: "l3", name: "Station Bins", viz: "hexbin" },
    ]);
  });

  it("hands value search only visible, non-aggregated layers", async () => {
    await get("q=x");
    expect(searchValues).toHaveBeenCalledTimes(1);
    const [layers, q] = searchValues.mock.calls[0];
    expect(q).toBe("x");
    expect(layers.map((l: { layerId: string }) => l.layerId)).toEqual(["l1"]);
    // The effective SQL, not the raw layer SQL, is what the scan reads.
    expect(layers[0].sql).toContain("SELECT 1");
  });

  it("applies the layer's filters to the effective SQL it hands over", async () => {
    mapWithLayers.mockReturnValue({
      id: "m1",
      layers: [
        layer({
          filters: [{ kind: "values", field: "line", values: ["U2"] }],
        }),
      ],
    });
    await get("q=x");
    const [layers] = searchValues.mock.calls[0];
    expect(layers[0].sql).toContain("line");
  });

  it("offers coordinate readings alongside", async () => {
    const body = await (await get("q=" + encodeURIComponent("52.5, 13.4"))).json();
    expect(body.coordinates).toEqual([
      { reading: "latlon", lat: 52.5, lng: 13.4 },
      { reading: "lonlat", lat: 13.4, lng: 52.5 },
    ]);
    expect(body.layers).toEqual([]);
  });

  it("holds places out unless asked; unconfigured answers honestly (S4)", async () => {
    const without = await (await get("q=berlin")).json();
    expect(without.places).toBeUndefined();
    const withFlag = await (await get("q=berlin&places=1")).json();
    expect(withFlag.places).toEqual({ state: "unconfigured" });
  });

  it("refuses an empty query", async () => {
    const res = await get("q=");
    expect(res.status).toBe(400);
    const missing = await GET(testAccountRequest(new Request("http://test/api/maps/m1/search")), {
      params: Promise.resolve({ id: "m1" }),
    });
    expect(missing.status).toBe(400);
  });
});
