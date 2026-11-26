import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OPERATIONS } from "@/lib/operations/catalog";
import type { TableInspection, TableListing } from "./api";
import { typedInHome } from "./builder/add-layer/catalog-state";
import { TableCard } from "./data-cards";
import { datasetSqlName } from "./dataset-sql-name";
import { starterSql } from "./sql/sql-draft";
import { TableDetailScreen } from "./TableDetailScreen";
import { useAsync } from "./ui/AsyncState";
import { canvasGraph } from "./workflow-canvas/graph";
import { paneRow } from "./workflow-canvas/home-names";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/tables/roads" }));
vi.mock("./ui/AsyncState", async (original) => ({ ...(await original<typeof import("./ui/AsyncState")>()), useAsync: vi.fn() }));
vi.mock("./builder/drawer/use-recipes", () => ({ useRecipes: () => ({ recipes: [], error: null, reload: vi.fn() }) }));
vi.mock("./TablePreviewMap", () => ({ TablePreviewMap: () => null }));
vi.mock("./shell/PlainCrumbTail", () => ({ PlainCrumbTail: () => null }));
vi.mock("./ExportMenu", () => ({ ExportMenu: () => null }));

/**
 * A dataset's SQL name, read by Bo. His own datasets are typed by their
 * plain names and Ada's with her SQL name, `ada.<name>`; each part is bare
 * where SQL reads it bare and quoted where it must be. The table page's
 * "In SQL:" line and a Data card show it the way the SQL page opens the
 * dataset as a query, so what Bo reads there is what he types. A map or a
 * workflow whose SQL belongs to Ada writes the same datasets the other way
 * round: hers plain, his own qualified.
 */

const ada = { name: "Ada Okafor", sqlName: "ada" };
const bo = { name: "Bo Lindqvist", sqlName: "bo" };

const listed = (name: string, owner: typeof ada): TableListing =>
  ({
    id: `${owner.sqlName}-${name}`, name, qualifiedName: owner === bo ? name : `${owner.sqlName}.${name}`, owner,
    sourceFilename: null, file: "tables/x.parquet", format: "csv", geometryColumn: "geom", geometryType: "POINT",
    crsAssumed: false, headerSuspect: false, rowCount: 3, source: "upload", sourceParams: null,
    createdAt: "2026-10-01T10:00:00Z", importedAt: "2026-10-01T10:00:00Z", sizeBytes: 1024, projectIds: ["P"],
  }) as unknown as TableListing;
const inspected = (name: string, owner: typeof ada): TableInspection =>
  ({ ...listed(name, owner), columns: [], preview: [], inputs: null }) as unknown as TableInspection;

/** The cases of the SQL name line: the dataset and the spelling it shows. */
const CASES: [string, TableListing, string][] = [
  ["his own dataset", listed("roads", bo), "roads"],
  ["someone else's", listed("roads", ada), "ada.roads"],
  ["his own, named by a keyword SQL reads bare", listed("year", bo), "year"],
  ["his own, named by a reserved word", listed("select", bo), '"select"'],
  ["someone else's, named by a reserved word", listed("order", ada), 'ada."order"'],
  ["his own, a name that needs quotes for its shape", listed("2024_roads", bo), '"2024_roads"'],
  ["someone else's, a name that needs quotes for its shape", listed("Roads 2024", ada), 'ada."Roads 2024"'],
];

describe("a dataset's SQL name", () => {
  it.each(CASES)("spells %s as the SQL page opens it as a query", (_label, table, spelled) => {
    expect(datasetSqlName(table)).toBe(spelled);
    // The SQL page's own opening statement for the dataset reads it so.
    expect(starterSql(table.qualifiedName)).toBe(`SELECT *\nFROM ${spelled}\nLIMIT 100;`);
  });

  it("spells two owners' same-named datasets apart", () => {
    expect(datasetSqlName(listed("roads", bo))).toBe("roads");
    expect(datasetSqlName(listed("roads", ada))).toBe("ada.roads");
  });

  it("names the dataset meant: each spelling reads that very dataset in the engine", async () => {
    const { DuckDBInstance } = await import("@duckdb/node-api");
    const instance = await DuckDBInstance.create(":memory:");
    const conn = await instance.connect();
    try {
      // Bo's datasets in his own namespace, Ada's under her SQL name, each
      // holding whose it is, so a spelling that falls to the other's
      // same-named dataset reads the wrong owner.
      await conn.run("CREATE SCHEMA ada");
      for (const [, table] of CASES) {
        const owner = table.owner.sqlName;
        const where = owner === "bo" ? "main" : "ada";
        await conn.run(`CREATE TABLE ${where}."${table.name}" AS SELECT '${owner}.${table.name}' AS meant`);
      }
      for (const [label, table] of CASES) {
        const read = await conn.runAndReadAll(`SELECT meant FROM ${datasetSqlName(table)}`);
        expect(String(read.getRowObjects()[0].meant), label).toBe(`${table.owner.sqlName}.${table.name}`);
      }
    } finally {
      conn.disconnectSync();
      instance.closeSync();
    }
  });
});

/** The text of the element marked `data-sql-name` in some markup. */
const sqlLine = (html: string) => {
  const line = /<[a-z]+[^>]*data-sql-name[^>]*>([\s\S]*?)<\/(?:p|span)>/.exec(html)?.[1] ?? null;
  return line === null ? null : line.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"');
};

describe("the table page's In SQL line", () => {
  const page = (table: TableInspection) => {
    vi.mocked(useAsync).mockReturnValue({ state: { status: "ready", value: table }, retry: vi.fn() });
    return renderToStaticMarkup(<TableDetailScreen name={table.qualifiedName} />);
  };

  it.each(CASES)("shows %s under the chips, the name in mono", (_label, table, spelled) => {
    const html = page(inspected(table.name, table.owner as typeof ada));
    expect(sqlLine(html)).toBe(`In SQL: ${spelled}`);
    // The words in the reading face, the name alone in a code mark.
    expect(html).toMatch(/data-sql-name[^>]*>In SQL: <code[^>]*>/);
    // Under the chips: the line follows the chips in the title block.
    expect(html.indexOf("data-sql-name")).toBeGreaterThan(html.indexOf("updated "));
    expect(html.indexOf("data-sql-name")).toBeLessThan(html.indexOf('data-add-to-map="primary"'));
  });
});

describe("a Data card's SQL name line", () => {
  const noop = () => {};
  const card = (table: TableListing) =>
    renderToStaticMarkup(
      <TableCard table={table} index={0} owner={table.owner === bo ? null : ada}
        actions={{ table, onOpen: noop, onQuery: noop, onAddToMap: noop, onFile: noop, onDelete: noop }} />,
    );

  it.each(CASES)("shows %s under the dataset's name", (_label, table, spelled) => {
    const html = card(table);
    expect(sqlLine(html)).toBe(spelled);
    expect(html.indexOf("data-sql-name")).toBeGreaterThan(html.indexOf(`>${table.name}</span>`));
  });
});

describe("the lists that write a dataset in someone else's SQL", () => {
  // Bo's listing: his own `roads` plain, Ada's qualified.
  const his = listed("roads", bo);
  const hers = listed("roads", ada);

  it("on a map whose SQL is Ada's, the Add layer catalogue writes hers plain and qualifies his own", () => {
    expect(typedInHome(hers, "ada")).toBe("roads");
    expect(typedInHome(his, "ada")).toBe("bo.roads");
  });

  it("on a workflow whose SQL is Ada's, the pane's Sources show the name a drop writes: hers plain, his own qualified", () => {
    const graph = canvasGraph({ steps: [], layout: { steps: {}, sources: {} }, tables: [his, hers], operations: OPERATIONS, home: "ada" });
    expect(paneRow(hers, graph)).toMatchObject({ written: "roads" });
    expect(paneRow(his, graph)).toMatchObject({ written: "bo.roads" });
  });
});
