import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DataTable, TableListing } from "./api";
import { TablePicker } from "./builder/drawer/TablePicker";
import { SuccessFace, type RunSuccess } from "./builder/drawer/SuccessFace";
import { PostgisCompletionFacts, type PostgisDataCompletion } from "./connections/PostgisDataDone";
import { TableRow } from "./data-cards";
import { GeometryBadge } from "./GeometryBadge";
import { geometryKindWord, resultKindWord } from "./geometry-class";
import { geometryChipLabel } from "./table-chips";
import { previewReadout } from "./TablePreviewMap";

vi.mock("./ExportMenu", () => ({ ExportMenu: () => null }));

/**
 * A geometry kind shown as a fact reads as the table page's chip does:
 * Points, Lines, Polygons, Mixed, Geometry, No geometry. Single and multi
 * kinds read the same, a mix of kinds or a collection reads Mixed, a kind
 * that isn't known reads Geometry, and no geometry at all reads No
 * geometry. Every surface that shows a kind as a fact says the same word.
 */

/** Every kind the engine and PostGIS name, and the word each reads as. */
const KINDS: [string | null, string][] = [
  ["POINT", "Points"],
  ["MULTIPOINT", "Points"],
  ["LINESTRING", "Lines"],
  ["MULTILINESTRING", "Lines"],
  ["POLYGON", "Polygons"],
  ["MULTIPOLYGON", "Polygons"],
  ["MultiPolygon", "Polygons"],
  ["POINT+POLYGON", "Mixed"],
  ["POINT+LINESTRING+POLYGON", "Mixed"],
  ["MIXED", "Mixed"],
  ["GEOMETRYCOLLECTION", "Mixed"],
  ["GEOMETRY", "Geometry"],
  ["CIRCULARSTRING", "Geometry"],
  [null, "Geometry"],
];

const table = (geometryType: string | null, geometryColumn: string | null = "geom"): TableListing =>
  ({
    id: "t1", name: "stations", qualifiedName: "stations", owner: { name: "Bo", sqlName: "bo" }, sourceFilename: "s.csv",
    format: "csv", file: "tables/s.parquet", geometryColumn, geometryType, crsAssumed: false, headerSuspect: false,
    rowCount: 1234, createdAt: "2026-10-01T10:00:00Z", source: "upload", sourceParams: null,
    importedAt: "2026-10-01T10:00:00Z", sizeBytes: 100, projectIds: [],
  }) as unknown as TableListing;
const noGeometry = table(null, null);
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'");

describe("one kind word", () => {
  it.each(KINDS)("reads %s as %s", (type, word) => {
    expect(geometryKindWord(type)).toBe(word);
    expect(geometryChipLabel(table(type))).toBe(word);
  });

  it("reads no geometry at all as No geometry, whatever type is recorded", () => {
    expect(geometryKindWord(null, false)).toBe("No geometry");
    expect(geometryKindWord("POINT", false)).toBe("No geometry");
    expect(geometryChipLabel(noGeometry)).toBe("No geometry");
  });
});

describe("the kind of a table a tool or a step makes", () => {
  it("reads as the same words, with the one surprise a preview names", () => {
    expect(resultKindWord("classified", "MULTIPOLYGON")).toBe("Polygons");
    expect(resultKindWord("classified", null)).toBe("Geometry");
    expect(resultKindWord("none", null)).toBe("No geometry");
    expect(resultKindWord("none", null, { preview: true })).toBe("No geometry: a table, not a layer");
    expect(resultKindWord("undetermined", null)).toBe("Geometry: no geometries to classify");
    expect(resultKindWord("undetermined", null, { preview: true })).toBe("Geometry: no geometries to classify");
  });
});

describe("the surfaces that show a kind as a fact", () => {
  it.each(KINDS)("the Data list's Geometry column reads %s as %s", (type, word) => {
    const noop = () => {};
    const row = (t: TableListing) =>
      renderToStaticMarkup(
        <table><tbody><TableRow table={t} actions={{ table: t, onOpen: noop, onQuery: noop, onAddToMap: noop, onFile: noop, onDelete: noop }} /></tbody></table>,
      );
    const cell = (html: string) => /<td class="[^"]*geomCell[^"]*">([^<]*)/.exec(html)?.[1];
    expect(cell(row(table(type)))).toBe(word);
    expect(cell(row(noGeometry))).toBe("No geometry");
  });

  it.each(KINDS)("the Add layer catalogue's capsule reads %s as %s", (type, word) => {
    expect(text(renderToStaticMarkup(<GeometryBadge table={table(type)} />))).toBe(word);
    expect(text(renderToStaticMarkup(<GeometryBadge table={noGeometry} />))).toBe("No geometry");
  });

  it.each(KINDS.filter(([type]) => type !== null))("the table page's preview readout reads %s as %s", (type, word) => {
    const read = { ok: true, name: "stations", geometryType: type, featureCount: 5, sampled: false } as const;
    expect(previewReadout(read, false)).toEqual(["5 features", word, "EPSG:4326"]);
  });

  it("the table page's preview readout leaves the kind out when the read names none", () => {
    expect(previewReadout({ ok: true, name: "stations", geometryType: null, featureCount: 0, sampled: false }, true)).toEqual(["0 features", "WGS84 assumed"]);
  });

  it("the tool drawer's chosen input and its result read the kind as a word", () => {
    const picked = renderToStaticMarkup(
      <TablePicker tables={[table("MULTIPOLYGON")]} recipes={[]} accepts={["polygon"]} value="stations" onPick={() => {}} label="Table" />,
    );
    expect(text(picked)).toContain("1,234 features · Polygons");
    const made: RunSuccess = { tool: "Buffer", table: "stations_buffer", rows: 12, geometryType: "MULTIPOLYGON", spatial: true, layerName: null, notice: "Done." };
    expect(text(renderToStaticMarkup(<SuccessFace made={made} onRunAnother={() => {}} onDone={() => {}} />))).toContain("12 rows · Polygons");
    const face = (m: RunSuccess) => text(renderToStaticMarkup(<SuccessFace made={m} onRunAnother={() => {}} onDone={() => {}} />));
    expect(face({ ...made, geometryType: null, spatial: false })).toContain("12 rows · No geometry");
    expect(face({ ...made, geometryType: null, spatial: true })).toContain("12 rows · Geometry: no geometries to classify");
  });

  it("a PostGIS import's completion reads the kind as a word", () => {
    const completion = (type: string | null, column: string | null) =>
      ({
        connection: { name: "Survey" },
        relation: { schema: "public", table: "parcels", kind: "table", system: false, geometryColumn: column, geometryType: type, srid: 4326, spatialKind: column ? "geometry" : null },
        table: { ...table(type, column), rowCount: 3 } as unknown as DataTable,
        filter: "",
      }) as unknown as PostgisDataCompletion;
    expect(text(renderToStaticMarkup(<PostgisCompletionFacts completion={completion("MULTIPOLYGON", "geom")} />))).toContain("3 rows · Polygons · snapshot of public.parcels");
    expect(text(renderToStaticMarkup(<PostgisCompletionFacts completion={completion(null, null)} />))).toContain("3 rows · No geometry · snapshot of");
  });
});
