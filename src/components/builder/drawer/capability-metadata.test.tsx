import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { TableListing } from "../../api";
import { OPERATIONS, type OperationDef } from "@/lib/operations/catalog";
import { withAvailability } from "@/lib/operations/capability";
import { OperationPicker } from "./OperationPicker";
import { TablePicker, TableRows } from "./TablePicker";
import { acceptsTable, groupTables, refusalFor } from "./derived-tables";
import { offeredColumns } from "./operation-form";

/**
 * The catalog says what a verb needs, and the drawer obeys it.
 *
 * **Every claim here is made twice: once for the shipped verb and once for a
 * verb invented in this file** carrying the same metadata. That is the whole
 * point of the criterion — if the drawer treats the invented one identically,
 * the behaviour belongs to the catalog's vocabulary rather than to geocoding,
 * and the next verb that declares the same things gets it without a change.
 */

/** A verb this repository does not ship, declaring exactly what the geocoder
 * declares: a capability, an input that takes no geometry, a text column. */
const INVENTED: OperationDef = {
  id: "invented_provider_verb",
  group: "Data",
  label: "Ask something else entirely",
  symbol: "pin",
  blurb: "A verb that exists only in this test",
  description:
    "A verb that exists only in this test, to prove the drawer reads the " +
    "catalog rather than knowing any verb by name.",
  inputs: [
    {
      name: "input",
      label: "Table",
      description: "A table with no geometry of its own.",
      accepts: ["none"],
      required: true,
    },
  ],
  accepts: ["none"],
  outputGeometry: { kind: "fixed", geometry: "point" },
  requires: ["geocoder"],
  parameters: [
    {
      name: "column",
      type: "field",
      ofInput: "input",
      fieldType: "text",
      required: true,
      description: "The text column to ask about.",
    },
    { name: "name", type: "string", required: true, description: "Name." },
  ],
};

const SHIPPED = OPERATIONS.find((o) => o.id === "geocode_addresses")!;
const BOTH = [SHIPPED, INVENTED];

function table(overrides: Partial<TableListing>): TableListing {
  return {
    id: "t1",
    name: "addresses",
    sourceFilename: "addresses.csv",
    format: "geoparquet",
    file: "tables/a.parquet",
    geometryColumn: null,
    geometryType: null,
    crsAssumed: false,
    rowCount: 3,
    createdAt: "2026-08-14T00:00:00.000Z",
    source: "upload",
    sourceParams: null,
    importedAt: "2026-08-14T00:00:00.000Z",
    sizeBytes: 100,
    ...overrides,
  } as TableListing;
}

afterEach(() => {
  delete process.env.DEZFIL_GEOCODER_URL;
  delete process.env.DEZFIL_ISOCHRONE_URL;
});

describe("an instance that cannot run a verb says so, in the picker", () => {
  it("disables both verbs and gives the reason when the capability is absent", () => {
    const html = renderToStaticMarkup(
      <OperationPicker
        operations={withAvailability(BOTH)}
        error={null}
        onPick={() => {}}
        
      />,
    );
    for (const operation of BOTH) {
      expect(html).toContain(`data-operation="${operation.id}"`);
      expect(html).toContain(`data-operation-unavailable="${operation.id}"`);
    }
    // Two disabled rows, not one — the invented verb is treated exactly as the
    // shipped one, which is what makes this the catalog's behaviour.
    expect(html.match(/disabled=""/g) ?? []).toHaveLength(2);
    expect(html).toContain("DEZFIL_GEOCODER_URL");
    // **Listed, not hidden**: a user looking for it learns it exists and what
    // their instance is missing.
    expect(html).toContain(SHIPPED.label);
    expect(html).toContain(INVENTED.label);
  });

  it("offers both once the instance is configured", () => {
    process.env.DEZFIL_GEOCODER_URL = "https://example.invalid/search";
    const html = renderToStaticMarkup(
      <OperationPicker
        operations={withAvailability(BOTH)}
        error={null}
        onPick={() => {}}
        
      />,
    );
    expect(html).not.toContain("disabled=");
    expect(html).not.toContain("data-operation-unavailable");
  });

  it("leaves a verb that declares no requirement alone", () => {
    const plain = OPERATIONS.find((o) => o.id === "centroid")!;
    const [answered] = withAvailability([plain]);
    expect(answered.availability).toEqual({ available: true, reason: null });
  });
});

describe("an input that takes no geometry", () => {
  const withGeometry = table({
    id: "t2",
    name: "stations",
    geometryColumn: "geometry",
    geometryType: "POINT",
  });
  const withoutGeometry = table({});

  it("accepts a table without geometry and refuses one with it, for both verbs", () => {
    for (const operation of BOTH) {
      const accepts = operation.inputs[0].accepts;
      expect(acceptsTable(accepts, withoutGeometry), operation.id).toBe(true);
      expect(acceptsTable(accepts, withGeometry), operation.id).toBe(false);
      // And the refusal is in the input's own terms rather than the geometry
      // sentence, which would read "needs none geometry".
      expect(refusalFor(accepts, withGeometry)).toContain(
        "writes geometry onto every row",
      );
    }
  });

  it("disables the geometry-carrying row in the rows, with that reason", () => {
    // The rows are held directly against the catalog's metadata: the picker
    // itself shows no list until its field is focused, which static markup
    // cannot drive — and which the next assertion pins.
    const html = renderToStaticMarkup(
      <TableRows
        groups={groupTables([withoutGeometry, withGeometry], [])}
        accepts={INVENTED.inputs[0].accepts}
        onPick={() => {}}
      />,
    );
    expect(html).toContain('data-table-row="addresses"');
    expect(html).toContain('data-table-row="stations"');
    expect(html.match(/disabled=""/g) ?? []).toHaveLength(1);
    expect(html).toContain("writes geometry onto every row");
  });

  it("renders no rows before the search field is focused", () => {
    const html = renderToStaticMarkup(
      <TablePicker
        tables={[withoutGeometry, withGeometry]}
        recipes={[]}
        accepts={INVENTED.inputs[0].accepts}
        value={null}
        onPick={() => {}}
        label="Table"
      />,
    );
    expect(html).not.toContain("data-table-row");
  });
});

describe("a parameter that names a text column", () => {
  const columns = [
    { name: "address", type: "VARCHAR" },
    { name: "count", type: "BIGINT" },
    { name: "labels", type: "VARCHAR[]" },
  ];

  it("offers text columns only, for both verbs", () => {
    for (const operation of BOTH) {
      const parameter = operation.parameters.find((p) => p.name === "column")!;
      expect(offeredColumns(parameter, columns).map((c) => c.name), operation.id)
        // Not the number, and not the *list* of text — a list of addresses is
        // not an address, which is why the predicate is anchored.
        .toEqual(["address"]);
    }
  });

  it("offers everything to a parameter that declares no kind", () => {
    const hotspot = OPERATIONS.find((o) => o.id === "hotspot")!;
    const field = hotspot.parameters.find((p) => p.name === "field")!;
    expect(field.fieldType).toBeUndefined();
    expect(offeredColumns(field, columns)).toHaveLength(3);
  });
});

describe("the isochrone row carries its own dependency", () => {
  it("is visible and disabled with the served reason, then enabled once configured", () => {
    const isochrone = OPERATIONS.find((o) => o.id === "isochrone")!;
    let html = renderToStaticMarkup(
      <OperationPicker
        operations={withAvailability([isochrone])}
        error={null}
        onPick={() => {}}
      />,
    );
    // Listed, not hidden — and the reason is the served sentence naming
    // this verb's own setting, not the geocoder's.
    expect(html).toContain('data-operation="isochrone"');
    expect(html).toContain('data-operation-unavailable="isochrone"');
    expect(html).toContain("DEZFIL_ISOCHRONE_URL");
    expect(html).not.toContain("DEZFIL_GEOCODER_URL");

    process.env.DEZFIL_ISOCHRONE_URL = "https://router.invalid/isochrone";
    html = renderToStaticMarkup(
      <OperationPicker
        operations={withAvailability([isochrone])}
        error={null}
        onPick={() => {}}
      />,
    );
    expect(html).not.toContain("data-operation-unavailable");
  });
});
