import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TableInspection } from "./api";
import { TableDetailScreen } from "./TableDetailScreen";
import { useAsync } from "./ui/AsyncState";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/tables/roads" }));
vi.mock("./ui/AsyncState", async (original) => ({ ...(await original<typeof import("./ui/AsyncState")>()), useAsync: vi.fn() }));
vi.mock("./builder/drawer/use-recipes", () => ({ useRecipes: () => ({ recipes: [], error: null, reload: vi.fn() }) }));
vi.mock("./TablePreviewMap", () => ({ TablePreviewMap: () => null }));
vi.mock("./shell/PlainCrumbTail", () => ({ PlainCrumbTail: () => null }));

/**
 * A dataset is changed by its owner alone, whatever role the reader holds
 * on the project that files it: the API refuses another person's re-run
 * and delete, so the page offers them only on one's own dataset. One's own
 * dataset is typed by its plain name; someone else's by `<sql name>.<name>`.
 */
const own: TableInspection = {
  id: "fixture", name: "roads", sourceFilename: null, file: "tables/fixture.parquet", format: "csv", geometryColumn: "geometry", geometryType: "POINT",
  crsAssumed: false, headerSuspect: false, rowCount: 3, source: "url", sourceParams: { url: "https://example.test/roads.csv" },
  createdAt: "2026-10-01T10:00:00Z", importedAt: "2026-10-01T10:00:00Z", columns: [], preview: [], sizeBytes: 1024, projectIds: ["P"], inputs: null,
  owner: { name: "Bo", sqlName: "bo" }, qualifiedName: "roads",
};
const theirs: TableInspection = { ...own, owner: { name: "Ada", sqlName: "ada" }, qualifiedName: "ada.roads" };

function markup(table: TableInspection): string {
  vi.mocked(useAsync).mockReturnValue({ state: { status: "ready", value: table }, retry: vi.fn() });
  return renderToStaticMarkup(<TableDetailScreen name={table.qualifiedName} />);
}

describe("the dataset page's owner-only actions", () => {
  it("offers its owner the re-run and the delete", () => {
    const html = markup(own);
    expect(html).toContain('aria-label="Re-run the stored import"');
    expect(html).toContain('aria-label="Delete roads"');
  });

  it("offers neither on someone else's dataset, while reading, querying and exporting stay", () => {
    const html = markup(theirs);
    expect(html).not.toContain("Re-run the stored import");
    expect(html).not.toContain('aria-label="Delete roads"');
    expect(html).not.toContain("Delete this table and its data");
    expect(html).toContain('aria-label="Query roads in SQL"');
    expect(html).toContain("Add to a map");
  });

  it("offers an Overture dataset's move to the latest release to its owner alone", () => {
    const overture = { source: "overture" as const, sourceParams: { theme: "transportation", type: "segment", release: "2026-09-17.0" } };
    expect(markup({ ...own, ...overture })).toContain("Update to latest release");
    expect(markup({ ...theirs, ...overture })).not.toContain("Update to latest release");
  });
});
