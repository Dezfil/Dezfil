import { describe, expect, it } from "vitest";
import { BASEMAPS, SATELLITE_STYLE_URL, type BasemapStyle } from "./basemap";
import { BUILT_IN_PICTURE_BASEMAPS, picturesCredit, type PictureBasemaps, type PicturedMap } from "./picture-credit";

/**
 * What one line for a page of map pictures names: the credit of each
 * basemap the pictures were drawn on, once each, in an order that does not
 * follow the page's own sort. A map with no picture shows chart paper and
 * credits nothing. The expected words are written here, never read from
 * the module under test.
 */

const OMT = { label: "© OpenMapTiles", href: "https://openmaptiles.org" };
const OSM = { label: "© OpenStreetMap", href: "https://www.openstreetmap.org/copyright" };
const SATELLITE: BasemapStyle = {
  key: "satellite", label: "Satellite", url: SATELLITE_STYLE_URL, kind: "imagery",
  attribution: [{ label: "© Imagery Provider" }],
};
const WITH_SATELLITE: PictureBasemaps = { ...BUILT_IN_PICTURE_BASEMAPS, basemaps: [...BASEMAPS, SATELLITE] };

const pictured = (basemap: PicturedMap["basemap"], customBasemap: PicturedMap["customBasemap"] = null): PicturedMap =>
  ({ basemap, customBasemap, hasThumbnail: true });
const chartPaper = (basemap: PicturedMap["basemap"] = null): PicturedMap =>
  ({ basemap, customBasemap: null, hasThumbnail: false });
const library = (url: string, ...labels: string[]): PicturedMap["customBasemap"] =>
  ({ url, name: null, attribution: labels.map((label) => ({ label })) });

const named = (maps: PicturedMap[], instance: PictureBasemaps = WITH_SATELLITE) =>
  picturesCredit(maps, instance, "light");

describe("the line for a page of map pictures", () => {
  it("names the built-in credit once for any number of maps on the built-in styles, Auto among them", () => {
    expect(named([pictured(null), pictured("dark"), pictured("light"), pictured("streets")])).toEqual([OMT, OSM]);
  });

  it("names the built-in credit, then Satellite's configured one", () => {
    expect(named([pictured("satellite"), pictured(null)])).toEqual([OMT, OSM, { label: "© Imagery Provider" }]);
  });

  it("names a library or a single map's style by its saved credit, a shared line once", () => {
    const own = library("https://styles.example/harbour.json", "© Harbour Tiles", "© OpenMapTiles");
    expect(named([pictured("streets", own)])).toEqual([{ label: "© Harbour Tiles" }, { label: "© OpenMapTiles" }]);
    expect(named([pictured(null), pictured("streets", own)]).map((line) => line.label))
      .toEqual(["© OpenMapTiles", "© OpenStreetMap", "© Harbour Tiles"]);
  });

  it("names nothing for maps on chart paper, whatever basemap they would be drawn on", () => {
    expect(named([chartPaper(), chartPaper("satellite"), chartPaper("dark")])).toEqual([]);
    expect(named([])).toEqual([]);
    expect(named([chartPaper("satellite"), pictured("dark")])).toEqual([OMT, OSM]);
  });

  it("keeps one order whatever order the page lists its maps in", () => {
    const a = library("https://a.example/style.json", "© Alder Maps");
    const z = library("https://z.example/style.json", "© Zephyr Maps");
    const maps = [pictured("streets", z), pictured("satellite"), pictured("dark"), pictured(null, a)];
    const expected = ["© OpenMapTiles", "© OpenStreetMap", "© Imagery Provider", "© Alder Maps", "© Zephyr Maps"];
    expect(named(maps).map((line) => line.label)).toEqual(expected);
    expect(named([...maps].reverse()).map((line) => line.label)).toEqual(expected);
  });

  it("credits an Auto map under the deployment's own style with the credit that style configured, and nothing without one", () => {
    const pinned: PictureBasemaps = { ...WITH_SATELLITE, overrideUrl: "https://tiles.internal/style.json", overrideAttribution: [{ label: "© Internal Tiles" }] };
    expect(named([pictured(null), pictured("light")], pinned).map((line) => line.label))
      .toEqual(["© OpenMapTiles", "© OpenStreetMap", "© Internal Tiles"]);
    expect(named([pictured(null)], { ...pinned, overrideAttribution: [] })).toEqual([]);
  });
});
