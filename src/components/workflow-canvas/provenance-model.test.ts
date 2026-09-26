import { describe, it, expect } from "vitest";
import { ASSUMED, disclosureFields, importedSentence, inputLine, NO_ENDPOINT, NO_SQL_PROVIDER, provenanceOf } from "./provenance-model";

const labels = new Map([["buffer", "Buffer"], ["geocode", "Geocode addresses"]]);
const labelOf = (id: string) => labels.get(id) ?? null;
const base = { sourceFilename: null, importedAt: "2026-08-26T10:00:00Z", crsAssumed: false } as const;

describe("the Provenance tab's words", () => {
  it("a derived table: the catalogue's label, the run time, the inputs with their three resolutions, the assumption, the SQL byte for byte", () => {
    const sql = "SELECT *\nFROM \"stations\" -- the run's own text";
    const p = provenanceOf(
      { ...base, source: "operation", crsAssumed: true, sourceParams: { operation: "buffer", sql, ranAt: "2026-08-26T09:59:00Z", inputs: [{ id: "a", name: "stations" }] } },
      [
        { name: "stations", currentName: "stations", missing: false },
        { name: "roads", currentName: "roads_2026", missing: false },
        { name: "parks", missing: true },
        { name: "cafes", missing: true, nameReclaimed: true },
      ],
      labelOf,
    );
    expect(p).toEqual({
      kind: "derived",
      operation: "Buffer",
      ranAt: "2026-08-26T09:59:00Z",
      inputs: [
        { name: "stations", resolution: null },
        { name: "roads", resolution: "now roads_2026" },
        { name: "parks", resolution: "deleted" },
        { name: "cafes", resolution: "deleted, another table has its name now" },
      ],
      assumed: true,
      body: { kind: "sql", sql },
    });
    expect(ASSUMED).toBe("Coordinates assumed WGS84: an input had no declared coordinate system.");
    // An identifier the catalogue no longer has is shown as itself; a record without ranAt falls to the table's time.
    const unknown = provenanceOf({ ...base, source: "operation", sourceParams: { operation: "vanished_op", sql: "SELECT 1", inputs: [] } }, [], labelOf);
    expect(unknown.kind === "derived" && unknown.operation).toBe("vanished_op");
    expect(unknown.kind === "derived" && unknown.ranAt).toBe("2026-08-26T10:00:00Z");
    expect(inputLine({ name: "x", missing: false })).toEqual({ name: "x", resolution: null });
  });

  it("a provider node's dataset: the disclosure field by field, the endpoint set apart without a query string, no SQL", () => {
    const disclosure = {
      endpoint: "https://nominatim.example.org/search?format=json&key=SECRET",
      parameters: { format: "json", limit: 1 },
      normalization: 2,
      fromCache: 3,
      fromWire: 4,
      attributions: ["© OpenStreetMap contributors"],
    };
    const p = provenanceOf({ ...base, source: "operation", sourceParams: { operation: "geocode", disclosure, inputs: [] } }, [], labelOf);
    expect(p.kind).toBe("derived");
    if (p.kind !== "derived" || p.body.kind !== "disclosure") throw new Error("expected a disclosure");
    expect(p.operation).toBe("Geocode addresses");
    expect(p.body.endpoint).toBe("https://nominatim.example.org/search");
    expect(p.body.fields).toEqual([
      { label: "parameters", value: "format json, limit 1" },
      { label: "normalization", value: "2" },
      { label: "from cache", value: "3" },
      { label: "from wire", value: "4" },
      { label: "attributions", value: "© OpenStreetMap contributors" },
    ]);
    expect(JSON.stringify(p)).not.toContain("SECRET");
    expect(JSON.stringify(p)).not.toContain('"sql"');
    expect(NO_SQL_PROVIDER).toBe("No SQL is recorded for a provider node.");
    // A record without an endpoint says so; the isochrone shape renders the same way.
    const iso = disclosureFields({ endpoint: null, travelMode: "walk", costing: "pedestrian", bands: [5, 10], unit: "minutes", departureTime: "none", originsFromCache: 0, originsFromWire: 2 });
    expect(iso.endpoint).toBeNull();
    expect(NO_ENDPOINT).toBe("The endpoint is not recorded.");
    expect(iso.fields.map((f) => `${f.label}: ${f.value}`)).toEqual([
      "travel mode: walk",
      "costing: pedestrian",
      "bands: 5, 10",
      "unit: minutes",
      "departure time: none",
      "origins from cache: 0",
      "origins from wire: 2",
    ]);
  });

  it("every imported kind in the record's terms only, the time exactly when the record has one, no refresh hint", () => {
    expect(importedSentence({ source: "upload", sourceFilename: "stations.csv", sourceParams: null })).toBe("Uploaded as stations.csv");
    expect(importedSentence({ source: "upload", sourceFilename: null, sourceParams: null })).toBe("Uploaded as a file");
    expect(importedSentence({ source: "url", sourceFilename: null, sourceParams: { url: "https://x.example/a.geojson" } })).toBe("Imported from https://x.example/a.geojson");
    expect(importedSentence({ source: "overture", sourceFilename: null, sourceParams: { theme: "places", release: "2026-07-23.0" } })).toBe("Overture places · release 2026-07-23.0");
    expect(importedSentence({ source: "osm", sourceFilename: null, sourceParams: { selectors: ["amenity=cafe", "amenity=bar"] } })).toBe("Overpass query: amenity=cafe, amenity=bar");
    expect(importedSentence({ source: "osm", sourceFilename: null, sourceParams: { query: "[out:json];" } })).toBe("Custom Overpass query");
    expect(importedSentence({ source: "postgis", sourceFilename: null, sourceParams: { schema: "public", table: "roads", connectionName: "prod" } })).toBe("Snapshot of public.roads from prod");
    expect(importedSentence({ source: "sketch", sourceFilename: null, sourceParams: { mapName: "Berlin", mapId: "m" } })).toBe("Drawn on Berlin");
    expect(importedSentence({ source: "sketch", sourceFilename: null, sourceParams: null })).toBe("Drawn on a map");
    for (const s of ["Uploaded", "Imported", "Overture", "Overpass", "Snapshot", "Drawn"]) {
      expect(importedSentence({ source: "osm", sourceFilename: null, sourceParams: { selectors: ["a=b"] } })).not.toContain("Refresh");
      void s;
    }
    // The last-produced time: present when the record has one, absent when it has not (a sketch never edited since it was drawn).
    const drawn = provenanceOf({ ...base, importedAt: null, source: "sketch", sourceParams: { mapName: "Berlin" } }, null, labelOf);
    expect(drawn).toEqual({ kind: "imported", sentence: "Drawn on Berlin", producedAt: null, assumed: false });
    const edited = provenanceOf({ ...base, source: "sketch", sourceParams: { mapName: "Berlin" } }, null, labelOf);
    expect(edited.kind === "imported" && edited.producedAt).toBe("2026-08-26T10:00:00Z");
    const csv = provenanceOf({ ...base, source: "upload", sourceFilename: "s.csv", crsAssumed: true, sourceParams: null }, null, labelOf);
    expect(csv).toEqual({ kind: "imported", sentence: "Uploaded as s.csv", producedAt: "2026-08-26T10:00:00Z", assumed: true });
  });
});
