import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TablePreviewGrid } from "./TablePreviewGrid";

const columns = [{ name: "name", type: "VARCHAR" }, { name: "geom_wkt", type: "VARCHAR" }];

describe("the dataset page's Data preview grid", () => {
  it("renders every column's name and type in the header and each row's value in a titled cell", () => {
    const html = renderToStaticMarkup(
      <TablePreviewGrid columns={columns} rows={[{ name: "Hanau Hbf", geom_wkt: "POINT(8.9293 50.1208)" }]} />,
    );
    expect(html).toContain(">name<");
    expect(html).toContain(">VARCHAR<");
    expect(html).toContain('title="POINT(8.9293 50.1208)"');
    expect(html).toContain(">POINT(8.9293 50.1208)<");
    const escaped = renderToStaticMarkup(<TablePreviewGrid columns={columns} rows={[{ name: "<b>x</b>", geom_wkt: "" }]} />);
    expect(escaped).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(escaped).not.toContain("<b>x</b>");
  });
  it("renders a null or missing value as the empty glyph, never as the word null", () => {
    const html = renderToStaticMarkup(<TablePreviewGrid columns={columns} rows={[{ name: null }]} />);
    expect(html.match(/∅/g)).toHaveLength(2);
    expect(html).not.toContain(">null<");
    expect(html).not.toContain(">undefined<");
    expect(html).toContain('title=""');
  });
  it("a column named __proto__ or constructor shows the row's own value, and a row without one shows the empty glyph, never what the prototype carries", () => {
    const inherited = [{ name: "__proto__", type: "VARCHAR" }, { name: "constructor", type: "VARCHAR" }];
    // Rows arrive as parsed JSON, which keeps either name as an own key.
    const own = renderToStaticMarkup(<TablePreviewGrid columns={inherited} rows={[JSON.parse('{"__proto__":"north","constructor":"Ada"}')]} />);
    expect(own).toContain('title="north"');
    expect(own).toContain(">north<");
    expect(own).toContain(">Ada<");
    const missing = renderToStaticMarkup(<TablePreviewGrid columns={inherited} rows={[{}]} />);
    expect(missing.match(/∅/g)).toHaveLength(2);
    expect(missing).not.toContain("[object Object]");
    expect(missing).not.toContain("function Object");
  });
});

describe("the grid while the set-geometry panel is open", () => {
  const rows = [{ name: "a", geom_wkt: "POINT(1 2)" }, { name: "b", geom_wkt: "n/a" }, { name: "c", geom_wkt: null }, { name: "d", geom_wkt: "POINT(3 4)" }];
  it("the marked rows are the sample's own, by index; a missing row is not marked; the chosen column's cells carry the mark", () => {
    const html = renderToStaticMarkup(<TablePreviewGrid columns={columns} rows={rows} tags={{ geom_wkt: "geometry" }} marks={[false, true, false, false]} />);
    const trs = html.match(/<tr[^>]*>/g) ?? [];
    expect(trs.map((t) => t.includes("data-bad"))).toEqual([false, false, true, false, false]);
    expect(html).toContain('title="n/a" data-pick="true" data-bad="true"');
    expect(html).not.toContain('title="b" data-pick');
    expect(html.match(/data-bad="true"/g)).toHaveLength(2);
  });
  it("the chosen columns are tagged in the header with the drawn word and tinted down the column", () => {
    const html = renderToStaticMarkup(<TablePreviewGrid columns={[{ name: "lon", type: "DOUBLE" }, { name: "lat", type: "DOUBLE" }, { name: "n", type: "BIGINT" }]} rows={[{ lon: 1, lat: 2, n: 3 }]} tags={{ lon: "longitude", lat: "latitude" }} />);
    expect(html).toMatch(/<th data-pick="true">.*?lon.*?>longitude<\/span><\/th>/);
    expect(html).toMatch(/<th data-pick="true">.*?lat.*?>latitude<\/span><\/th>/);
    expect(html).toMatch(/<th>.*?>n<\/span>.*?<\/th>/);
    expect(html.match(/<td[^>]*data-pick="true"/g)).toHaveLength(2);
  });
  it("a column named __proto__ or constructor gets no tag from a map that does not name it, and a tag on it is its own property", () => {
    const inherited = [{ name: "__proto__", type: "VARCHAR" }, { name: "constructor", type: "VARCHAR" }];
    const untagged = renderToStaticMarkup(<TablePreviewGrid columns={inherited} rows={[{ a: 1 }]} />);
    expect(untagged).not.toContain("data-pick");
    const tagged = renderToStaticMarkup(<TablePreviewGrid columns={inherited} rows={[]} tags={{ ["__proto__"]: "geometry" }} />);
    expect(tagged.match(/data-pick="true"/g)).toHaveLength(1);
    expect(tagged).toContain(">geometry</span>");
  });
});
