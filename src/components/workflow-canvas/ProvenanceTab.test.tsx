import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TableInspection } from "../api";
import { ProvenanceTab } from "./ProvenanceTab";

/**
 * The Provenance tab rendered over an independently supplied inspection
 * answer ((b) and 5(c)): the resolutions no shipped action can bring
 * about live, the provider disclosure with and without an endpoint, no
 * SQL and no query string shown.
 */
const inspection = (o: Partial<TableInspection>): TableInspection =>
  ({
    id: "t1", name: "out", sourceFilename: null, format: "geoparquet", file: "x.parquet", geometryColumn: "geometry", geometryType: "POINT",
    crsAssumed: false, headerSuspect: false, rowCount: 3, createdAt: "2026-08-26T10:00:00Z", source: "operation", sourceParams: null,
    importedAt: "2026-08-26T10:00:00Z", columns: [], preview: [], sizeBytes: 1, inputs: null, ...o,
  }) as TableInspection;
const labelOf = (id: string) => (id === "buffer" ? "Buffer" : id === "geocode" ? "Geocode addresses" : null);
const render = (t: TableInspection) => renderToStaticMarkup(<ProvenanceTab inspection={{ status: "read", value: t }} labelOf={labelOf} retry={() => {}} />);

describe("the Provenance tab rendered over a supplied answer ((b), 5(c))", () => {
  it("shows an input's three resolutions beside its recorded name, the assumption and the SQL", () => {
    const html = render(
      inspection({
        crsAssumed: true,
        sourceParams: { operation: "buffer", sql: "SELECT ST_Buffer(geom, 100) FROM roads", ranAt: "2026-08-26T09:59:00Z", inputs: [] },
        inputs: [
          { id: "a", name: "roads", currentName: "roads_2026", missing: false },
          { id: "b", name: "parks", missing: true },
          { id: "c", name: "cafes", missing: true, nameReclaimed: true },
          { id: "d", name: "same", currentName: "same", missing: false },
        ],
      }),
    );
    expect(html).toContain('Produced by <b data-band-operation="true">Buffer</b>');
    expect(html).toContain('data-ran-at="2026-08-26T09:59:00Z"');
    expect(html).toContain("<code>roads</code> (now roads_2026)");
    expect(html).toContain("<code>parks</code> (deleted)");
    expect(html).toContain("<code>cafes</code> (deleted, another table has its name now)");
    expect(html).toContain("<code>same</code></span>");
    expect(html).toContain("Coordinates assumed WGS84: an input had no declared coordinate system.");
    expect(html).toContain("data-band-sql");
    expect(html).toContain("ST_Buffer");
  });

  it("a provider node's dataset: the disclosure's fields, the endpoint without its query string, no SQL; and the absent-endpoint sentence", () => {
    const withEndpoint = render(
      inspection({
        sourceParams: {
          operation: "geocode",
          disclosure: { endpoint: "https://geo.example.org/search?key=SECRET", parameters: { format: "json", limit: 1 }, fromCache: 1, fromWire: 2 },
          inputs: [],
        },
      }),
    );
    expect(withEndpoint).toContain("Geocode addresses");
    expect(withEndpoint).toContain('data-band-endpoint="true">https://geo.example.org/search</dd>');
    expect(withEndpoint).not.toContain("SECRET");
    expect(withEndpoint).not.toContain("data-band-sql");
    expect(withEndpoint).toContain("No SQL is recorded for a provider node.");
    expect(withEndpoint).toContain("<dt>from cache</dt><dd>1</dd>");
    const without = render(inspection({ sourceParams: { operation: "geocode", disclosure: { endpoint: null, fromCache: 0, fromWire: 3 }, inputs: [] } }));
    expect(without).toContain("The endpoint is not recorded.");
  });

  it("an imported source: the record's sentence, the time exactly when the record has one", () => {
    const sketch = render(inspection({ source: "sketch", sourceParams: { mapName: "Berlin" }, importedAt: null }));
    expect(sketch).toContain("Drawn on Berlin");
    expect(sketch).not.toContain("data-produced-at");
    const csv = render(inspection({ source: "upload", sourceFilename: "stations.csv", crsAssumed: true }));
    expect(csv).toContain("Uploaded as stations.csv");
    expect(csv).toContain('data-produced-at="2026-08-26T10:00:00Z"');
    expect(csv).toContain("Coordinates assumed WGS84");
    const osm = render(inspection({ source: "osm", sourceParams: { selectors: ["amenity=cafe"] } }));
    expect(osm).toContain("Overpass query: amenity=cafe");
    expect(osm).not.toContain("Refresh");
  });
});
