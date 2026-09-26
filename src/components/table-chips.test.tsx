import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DataTable } from "./api";
import { CRS_DOOR_TIP, CRS_DOOR_TIP_ACTION, CrsChip } from "./table-chips";

const table: DataTable = {
  id: "t", name: "trips", sourceFilename: "trips.csv", format: "csv", file: "tables/t.parquet", geometryColumn: "geometry", geometryType: "LINESTRING",
  crsAssumed: true, headerSuspect: false, rowCount: 10, createdAt: "2026-09-13T10:00:00Z", source: "upload", sourceParams: null, importedAt: null,
};

describe("the assumed-CRS chip as a door", () => {
  it("with a door it is a button with the caret and the drawn tooltip's two lines; the chip follows the assumption flag", () => {
    const html = renderToStaticMarkup(<CrsChip table={table} onOpen={() => {}} />);
    expect(html).toMatch(/<button[^>]*data-set-geometry-door="crs"[^>]*>WGS84 assumed<svg/);
    expect(html).toContain('role="tooltip"');
    expect(html).toContain(CRS_DOOR_TIP);
    expect(html).toContain(`<small>${CRS_DOOR_TIP_ACTION}</small>`);
    expect(renderToStaticMarkup(<CrsChip table={{ ...table, crsAssumed: false }} onOpen={() => {}} />)).toBe("");
  });
  it("without a door, as the cards and rows render it, it is the shipped chip: no button, no caret, the native title", () => {
    const html = renderToStaticMarkup(<CrsChip table={table} />);
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("data-set-geometry-door");
    expect(html).toContain('title="The file declared no CRS; WGS84 was assumed"');
    expect(html).toContain(">WGS84 assumed<");
  });
});

describe("the chip on the Data page's cards and rows stays as shipped", () => {
  it("neither the card nor the row renders the door", async () => {
    const { TableCard, TableRow } = await import("./data-cards");
    const listing = { ...table, sizeBytes: 100, projectIds: [] };
    const actions = { table: listing, confirming: false, deleting: false, onOpen() {}, onQuery() {}, onAddToMap() {}, onFile() {}, onDeletePress() {}, onDeleteBlur() {}, onDeleteConfirm() {}, onDeleteCancel() {}, onDownload() {} } as unknown as Parameters<typeof TableCard>[0]["actions"];
    const card = renderToStaticMarkup(<TableCard table={listing} index={0} actions={actions} />);
    expect(card).toContain(">WGS84 assumed<");
    expect(card).not.toContain("data-set-geometry-door");
    const row = renderToStaticMarkup(<table><tbody><TableRow table={listing} actions={actions} /></tbody></table>);
    expect(row).toContain("WGS84 assumed");
    expect(row).not.toContain("data-set-geometry-door");
  });
});
