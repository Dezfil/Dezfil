import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TableInspection } from "./api";
import { BackLink } from "./BackLink";
import { TableDetailScreen } from "./TableDetailScreen";
import { useAsync } from "./ui/AsyncState";

/**
 * The square back arrow before a page's title: one link, named and titled
 * for where it leads, holding the arrow and no words. The dataset page
 * draws it before the dataset's name, as before it was shared.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/tables/roads" }));
vi.mock("./ui/AsyncState", async (original) => ({ ...(await original<typeof import("./ui/AsyncState")>()), useAsync: vi.fn() }));
vi.mock("./builder/drawer/use-recipes", () => ({ useRecipes: () => ({ recipes: [], error: null, reload: vi.fn() }) }));
vi.mock("./TablePreviewMap", () => ({ TablePreviewMap: () => null }));
vi.mock("./shell/PlainCrumbTail", () => ({ PlainCrumbTail: () => null }));

describe("the back arrow", () => {
  it("is one link to its list, named and titled for it, holding the arrow alone", () => {
    const html = renderToStaticMarkup(<BackLink href="/projects" label="Back to Projects" />);
    const a = /^<a ([^>]*)>(.*)<\/a>$/.exec(html);
    expect(a).not.toBeNull();
    expect(a![1]).toContain('href="/projects"');
    expect(a![1]).toContain('aria-label="Back to Projects"');
    expect(a![1]).toContain('title="Back to Projects"');
    expect(a![2]).toMatch(/^<svg[\s\S]*<\/svg>$/);
  });

  it("keeps the dataset page's square look", () => {
    const css = readFileSync("src/components/BackLink.module.css", "utf8");
    expect(css).toMatch(/\.back \{[^}]*width: 38px;[^}]*height: 38px;/);
    // Its one home: the dataset page no longer carries a copy.
    expect(readFileSync("src/components/TableDetailScreen.module.css", "utf8")).not.toMatch(/^\.back \{/m);
  });

  it("stands before the dataset's name on its page", () => {
    const table = {
      id: "fixture", name: "roads", sourceFilename: null, file: "tables/fixture.parquet", format: "csv", geometryColumn: "geometry",
      geometryType: "POINT", crsAssumed: false, headerSuspect: false, rowCount: 3, source: "upload", sourceParams: null,
      createdAt: "2026-10-01T10:00:00Z", importedAt: "2026-10-01T10:00:00Z", columns: [], preview: [], sizeBytes: 1024,
      projectIds: [], inputs: null, owner: { name: "Bo", sqlName: "bo" }, qualifiedName: "roads",
    } as unknown as TableInspection;
    vi.mocked(useAsync).mockReturnValue({ state: { status: "ready", value: table }, retry: vi.fn() });
    const html = renderToStaticMarkup(<TableDetailScreen name="roads" />);
    const back = /<a [^>]*aria-label="Back to Data"[^>]*>/.exec(html);
    expect(back?.[0]).toContain('href="/data"');
    expect(back!.index).toBeLessThan(html.indexOf("<h1>roads</h1>"));
  });
});
