import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TableListing } from "../../api";
import { CatalogTableBrowser } from "./CatalogTableBrowser";

const retainedUnknown: TableListing = {
  id: "empty-spatial",
  name: "empty_surface_catalog_proof",
  qualifiedName: "empty_surface_catalog_proof",
  sourceFilename: "empty_surface_catalog_proof.geojson",
  format: "geoparquet",
  file: "tables/empty_surface_catalog_proof.parquet",
  geometryColumn: "geom",
  geometryType: null,
  crsAssumed: false,
  rowCount: 0,
  createdAt: "2026-08-30T00:00:00.000Z",
  source: "upload",
  sourceParams: null,
  importedAt: null,
  sizeBytes: 0,
  projectIds: [],
} as unknown as TableListing;

describe("the add-layer catalog's retained unknown geometry row", () => {
  it("renders a spatial button whose accessible name is exactly the table name", () => {
    const html = renderToStaticMarkup(
      <CatalogTableBrowser
        listing={{
          world: { projects: [], all: [retainedUnknown] },
          worldError: null,
          offered: [retainedUnknown],
          offeredError: null,
          scope: { kind: "all" },
          onScope: () => {},
          onRetry: () => {},
        }}
        selected={null}
        onPick={() => {}}
      />,
    );
    const row = html.match(
      new RegExp(
        `<button[^>]*aria-label="${retainedUnknown.name}"[^>]*>`,
      ),
    )?.[0];

    expect(row).toBeDefined();
    expect(row).not.toContain('data-nonspatial="true"');
  });

  it("opens the Tables source before the empty-spatial journey asks for that row", () => {
    const journey = readFileSync(
      path.join(process.cwd(), "e2e/empty-spatial-result.spec.ts"),
      "utf8",
    );
    const catalog = journey.slice(
      journey.indexOf('const dialog = page.getByRole("dialog", { name: "Add layer" });'),
      journey.indexOf("await catalogRow.click();"),
    );

    expect(catalog).toContain(
      'await dialog.getByRole("button", { name: "Tables" }).click();',
    );
  });
});
