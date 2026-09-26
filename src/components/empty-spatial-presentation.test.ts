import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { DataTable } from "@/lib/metadata/tables";
import { geometryLabel } from "./api";
import { geometryFamilies, geometryKind } from "./gallery-icons";
import { geometryChipLabel } from "./table-chips";
import { classOfTable, geometryGlyphType } from "./geometry-class";

const table = (
  geometryColumn: string | null,
  geometryType: string | null,
): DataTable =>
  ({ geometryColumn, geometryType } as DataTable);

const retained = table("geom", null);
const plain = table(null, null);

describe("one column-first geometry vocabulary", () => {
  it("distinguishes retained unknown geometry from a non-spatial table", () => {
    expect(classOfTable(retained)).toBe("unknown");
    expect(classOfTable(plain)).toBe("none");
    expect(geometryLabel(retained)).toBe("geometry unknown");
    expect(geometryLabel(plain)).toBe("non-spatial");
    expect(geometryKind(retained.geometryType, retained.geometryColumn)).toBe(
      "mixed",
    );
    expect(
      geometryFamilies(retained.geometryType, retained.geometryColumn),
    ).toEqual(["point", "line", "polygon"]);
    expect(geometryChipLabel(retained)).toBe("Geometry");
    expect(geometryGlyphType(retained)).toBe("GEOMETRY");
    expect(geometryGlyphType(plain)).toBeNull();
  });

  it("is a strict presentation no-op for every classified family", () => {
    const cases = [
      ["POINT", "point", ["point"]],
      ["MULTILINESTRING", "line", ["line"]],
      ["POLYGON", "polygon", ["polygon"]],
      ["POINT+POLYGON", "mixed", ["point", "polygon"]],
      ["GEOMETRYCOLLECTION", "mixed", ["point", "line", "polygon"]],
    ] as const;
    for (const [type, kind, families] of cases) {
      const classified = table("geom", type);
      expect(geometryLabel(classified)).toBe(type.toLowerCase());
      expect(geometryKind(classified.geometryType, classified.geometryColumn)).toBe(
        kind,
      );
      expect(
        geometryFamilies(classified.geometryType, classified.geometryColumn),
      ).toEqual(families);
    }
  });
});

describe("the class-gated surfaces consume column-first state", () => {
  const files = [
    "GeometryBadge.tsx",
    "data-cards.tsx",
    "table-chips.tsx",
    "builder/add-layer/AddLayerCatalog.tsx",
    "builder/add-layer/CatalogTablesView.tsx",
    "builder/add-layer/CatalogTableBrowser.tsx",
    "builder/drawer/derived-tables.ts",
    "builder/drawer/TablePicker.tsx",
    "builder/use-layer-source-coordinator.ts",
    "workflow-canvas/CanvasPane.tsx",
    "workflow-canvas/SourceNode.tsx",
    "workflow-canvas/SourcePanel.tsx",
  ];

  it.each(files)("%s never decides spatial identity from geometryType", (file) => {
    const source = readFileSync(path.join(process.cwd(), "src/components", file), "utf8");
    expect(
      source.match(
        /geometryType\s*(?:===|!==)\s*null|geometryType\s*\?|!\s*[^\n]*geometryType/g,
      ) ?? [],
    ).toEqual([]);
  });

  it("keeps the known-class and no-geometry link refusals unchanged", () => {
    expect(classOfTable(table("geom", "POINT"))).toBe("point");
    expect(classOfTable(plain)).toBe("none");
  });
});

describe("zero-row and all-null agreement copy", () => {
  it.each([
    "builder/drawer/ParameterForm.tsx",
    "workflow-canvas/NodePanel.tsx",
  ])("%s says there are no geometries to classify", (file) => {
    const source = readFileSync(path.join(process.cwd(), "src/components", file), "utf8");
    expect({
      truthful: source.includes(
        "spatial, class undetermined: no geometries to classify",
      ),
      stale: source.includes(
        "spatial, class undetermined: no rows to classify",
      ),
    }).toEqual({ truthful: true, stale: false });
  });

  it("publishes the same truthful meaning for undetermined geometry", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/lib/api/openapi.ts"),
      "utf8",
    );
    expect({
      truthful: source.includes("it has one but no geometries to classify"),
      stale: source.includes("it has one but no rows"),
    }).toEqual({ truthful: true, stale: false });
  });
});
