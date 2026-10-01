import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TableListing } from "../../api";
import { CatalogTablesView } from "./CatalogTablesView";

const table = (source: TableListing["source"]): TableListing => ({
  id: source, name: `t_${source}`, sourceFilename: null, format: "csv", file: "tables/t.parquet", geometryColumn: null, geometryType: null,
  crsAssumed: false, headerSuspect: false, rowCount: 10, createdAt: "2026-09-13T00:00:00Z", source, sourceParams: null, importedAt: null, sizeBytes: 0, projectIds: [],
  owner: { name: "Ada", sqlName: "ada" }, qualifiedName: `t_${source}`,
});
const listing = { world: { projects: [], all: [] }, worldError: null, offered: [], offeredError: null, scope: { kind: "all" as const }, onScope() {}, onRetry() {} };
const view = (picked: TableListing | null, onSetGeometry?: (t: TableListing) => void) =>
  renderToStaticMarkup(<CatalogTablesView listing={listing} picked={picked} onPick={() => {}} name="" onName={() => {}} busy={false} error={null} onCreate={() => {}} onSetGeometry={onSetGeometry} />);

describe("the catalog's non-spatial note and its door", () => {
  it("carries the door only for a picked file-upload or URL-import table, when the dialog hands one in", () => {
    for (const source of ["upload", "url"] as const) {
      const html = view(table(source), () => {});
      expect(html).toContain("No geometry column. Still usable in the SQL source.");
      expect(html).toMatch(/<button[^>]*data-set-geometry-door="catalog"[^>]*>Set geometry<\/button>/);
    }
    for (const source of ["operation", "sketch", "postgis"] as const) {
      const html = view(table(source), () => {});
      expect(html).toContain("No geometry column. Still usable in the SQL source.");
      expect(html).not.toContain("Set geometry");
    }
    expect(view(table("upload"))).not.toContain("Set geometry");
    expect(view(null, () => {})).not.toContain("No geometry column");
  });
});
