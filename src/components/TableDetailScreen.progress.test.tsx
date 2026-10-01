import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { TableInspection } from "./api";
import { TableDetailScreen } from "./TableDetailScreen";
import { CLOSED_STATE } from "./set-geometry/panel-controller";
import { useSetGeometryPanel } from "./set-geometry/use-set-geometry-panel";

const { setTab, opening } = vi.hoisted(() => ({ setTab: vi.fn(), opening: { phase: "opening" as const } }));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: (initial: unknown) => {
    const result = react.useState(initial);
    return initial === "map" ? [result[0], setTab] : result;
  } };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/data/trips" }));
vi.mock("./ui/AsyncState", async original => ({ ...await original<typeof import("./ui/AsyncState")>(),
  useAsync: () => ({ state: { status: "ready", value: {
    id: "t", name: "trips", sourceFilename: "trips.csv", file: "tables/t.parquet", format: "csv", source: "upload",
    geometryColumn: null, geometryType: null, crsAssumed: false, rowCount: 325156, projectIds: [], columns: [], preview: [], sizeBytes: 1,
    createdAt: "2026-09-14T00:00:00Z", importedAt: "2026-09-14T00:00:00Z", inputs: null, headerSuspect: false, sourceParams: null,
    owner: { name: "Ada", sqlName: "ada" }, qualifiedName: "trips",
  } as TableInspection }, retry: vi.fn() }),
}));
vi.mock("./builder/drawer/use-recipes", () => ({ useRecipes: () => ({ recipes: [], error: null, reload: vi.fn() }) }));
vi.mock("./TablePreviewMap", () => ({ TablePreviewMap: () => null }));
vi.mock("./shell/PlainCrumbTail", () => ({ PlainCrumbTail: () => null }));
vi.mock("./set-geometry/use-set-geometry-panel", () => ({ useSetGeometryPanel: vi.fn(() => ({
  state: { ...CLOSED_STATE, ...opening }, controller: { cancel: vi.fn() }, open: vi.fn(), openByAddress: vi.fn(),
})) }));

it("field round: opening from the panel's shared door switches the page to Data preview", () => {
  renderToStaticMarkup(<TableDetailScreen name="trips" />);
  const options = vi.mocked(useSetGeometryPanel).mock.calls.at(-1)![0];
  expect(options.onOpen).toBeTypeOf("function");
  options.onOpen?.();
  expect(setTab).toHaveBeenCalledWith("data");
});
it("field round: busy Set geometry keeps its pin and a contrasting spinner", () => {
  const html = renderToStaticMarkup(<TableDetailScreen name="trips" />);
  const button = html.match(/<button[^>]*data-set-geometry-door="primary"[\s\S]*?<\/button>/)?.[0] ?? "";
  expect(button).toContain('aria-busy="true"');
  expect(button).toContain("<svg");
  expect(button).toContain('data-tone="current"');
  expect(button).toContain("Set geometry");
});
