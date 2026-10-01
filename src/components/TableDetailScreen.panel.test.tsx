import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TableInspection } from "./api";
import { CLOSED_STATE, type PanelState } from "./set-geometry/panel-controller";
import type { GeometryPreview } from "./set-geometry/types";
import { ListHeading } from "./ListHeading";
import { TableDetailScreen } from "./TableDetailScreen";
import { useAsync } from "./ui/AsyncState";
import { useSetGeometryPanel } from "./set-geometry/use-set-geometry-panel";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/tables/trips" }));
vi.mock("./ui/AsyncState", async (original) => ({ ...(await original<typeof import("./ui/AsyncState")>()), useAsync: vi.fn() }));
vi.mock("./builder/drawer/use-recipes", () => ({ useRecipes: () => ({ recipes: [], error: null, reload: vi.fn() }) }));
vi.mock("./TablePreviewMap", () => ({ TablePreviewMap: () => <div data-page-map="" /> }));
vi.mock("./set-geometry/ChoicePreviewMap", () => ({
  ChoicePreviewMap: ({ record }: { record: { crs: { srid: number | null } } | null }) => <div data-choice-preview="" data-record-srid={record ? String(record.crs.srid) : "none"} />,
}));
vi.mock("./shell/PlainCrumbTail", () => ({ PlainCrumbTail: () => null }));
vi.mock("./set-geometry/use-set-geometry-panel", () => ({ useSetGeometryPanel: vi.fn() }));

const table: TableInspection = {
  id: "fixture", name: "trips", sourceFilename: "trips.csv", file: "tables/fixture.parquet", format: "csv", geometryColumn: null, geometryType: null,
  crsAssumed: false, headerSuspect: false, rowCount: 1000, source: "upload", sourceParams: null, createdAt: "2026-09-13T10:00:00Z", importedAt: "2026-09-13T10:00:00Z",
  columns: [{ name: "id", type: "BIGINT" }, { name: "column01", type: "VARCHAR" }], preview: [{ id: 1, column01: "LINESTRING(1 2, 3 4)" }], sizeBytes: 1024, projectIds: [], inputs: null,
  owner: { name: "Ada", sqlName: "ada" }, qualifiedName: "trips",
};
const answer: GeometryPreview = {
  tableId: "t", revision: "r1", choice: { format: "wkt", columns: ["column01"] }, canApply: true, issues: [], rowCount: 1000, unreadableCount: 0, geometryType: "LINESTRING",
  extent: [1, 2, 3, 4], degreeCompatible: true,
  sample: { rows: [{ index: 0, values: { id: 1, column01: "LINESTRING(1 2, 3 4)" }, status: "readable" }, { index: 1, values: { id: 2, column01: "bad" }, status: "unreadable" }], features: { type: "FeatureCollection", features: [] } },
};
const controller = { getState: () => CLOSED_STATE, subscribe: () => () => {}, configure: vi.fn(), open: vi.fn(), openByAddress: vi.fn(), setFormat: vi.fn(), setColumn: vi.fn(), swap: vi.fn(), chooseProjection: vi.fn(), typeOtherCode: vi.fn(), apply: vi.fn(), cancel: vi.fn(), dismiss: vi.fn() };
function markup(state: PanelState): string {
  vi.mocked(useAsync).mockReturnValue({ state: { status: "ready", value: table }, retry: vi.fn() });
  vi.mocked(useSetGeometryPanel).mockReturnValue({ state, controller, open: vi.fn(), openByAddress: vi.fn() });
  return renderToStaticMarkup(<TableDetailScreen name="trips" />);
}
const open: PanelState = {
  ...CLOSED_STATE, phase: "open", mode: "first",
  inspection: { tableId: "t", revision: "r1", columns: table.columns, geometryColumn: null, geometryRecord: null, currentChoice: null, mode: "unmodified", candidates: [] },
  choice: { format: "wkt", columns: ["column01"], projection: { kind: "implicit", code: null, text: "" } },
  preview: { status: "ready", key: "k", answerKey: "k", message: null, answerRecord: null, answer },
};

describe("the dataset page while the set-geometry panel is open", () => {
  it("the dock sits beside the tabs, which carry the live tag, and the Map preview becomes the choice's", () => {
    const html = markup(open);
    expect(html).toContain("data-set-geometry-panel");
    expect(html).toContain("Preview of the choice");
    expect(html).toContain("data-choice-preview");
    expect(html).not.toContain("data-page-map");
    expect(html.indexOf("data-set-geometry-panel")).toBeLessThan(html.indexOf('role="tablist"'));
  });
  it("closed, the page's own previews stand with no dock, no live tag and no marks", () => {
    const html = markup(CLOSED_STATE);
    expect(html).not.toContain("data-set-geometry-panel");
    expect(html).not.toContain("Preview of the choice");
    expect(html).toContain("data-page-map");
    expect(html).not.toContain("data-choice-preview");
  });
  it("open on the native path with no preview yet, the page's own Map preview stands and the tag says the panel is live", () => {
    const html = markup({ ...open, marked: true, preview: { status: "idle", key: null, answerKey: null, message: null, answerRecord: null, answer: null } });
    expect(html).toContain("data-set-geometry-panel");
    expect(html).toContain("data-page-map");
    expect(html).toContain("Preview of the choice");
  });
  it("a dataset the API refuses to inspect shows the page as shipped with the refusal as the API words it, and no dock", () => {
    const html = markup({ ...CLOSED_STATE, openError: "Set geometry is available for file uploads and URL imports. SQL and workflow datasets take geometry from their SQL; PostGIS tables bring their own." });
    expect(html).toContain('role="alert"');
    expect(html.replace(/<[^>]+>/g, " ")).toContain("Set geometry is available for file uploads and URL imports. SQL and workflow datasets take geometry from their SQL; PostGIS tables bring their own.");
    expect(html).not.toContain("data-set-geometry-panel");
    expect(html).toContain("data-page-map");
  });
  it("the choice map is given the record its answer was read under, never the current inspection's", () => {
    const declared = { columns: ["column01"], format: "wkt" as const, signal: "content" as const, rule: "content" as const, crs: { stance: "declared" as const, srid: 25833, label: "ETRS89 / UTM 33N" }, unreadableCount: 0 };
    const html = markup({ ...open, inspection: { ...open.inspection!, revision: "r2", geometryRecord: declared }, preview: { ...open.preview, answerRecord: null } });
    expect(html).toContain('data-record-srid="none"');
  });
  it("nothing else on the page changes while the panel is open: the header's actions, the provenance and the export menu stay", () => {
    const html = markup(open);
    for (const part of ["Uploaded as trips.csv", "last run"]) expect(html.replace(/<[^>]+>/g, " ")).toContain(part);
    expect(html).toContain('data-hint="Export this table"');
    expect(html).toContain('aria-label="Query trips in SQL"');
    expect(html).toContain('aria-label="Delete trips"');
  });
});

describe("the Set geometry door while the inspection is in flight (field round)", () => {
  const opening: PanelState = { ...CLOSED_STATE, phase: "opening" };
  const door = (html: string) => html.match(/<button[^>]*data-set-geometry-door="primary"[^>]*>/)?.[0] ?? "";
  const prose = (html: string) => html.replace(/<[^>]+>/g, "");
  it("the door goes busy at once and the dock's slot says the dataset is being read; nothing is silent", () => {
    // Seeded defect: the opening phase rendered nothing, so a 12 s
    // inspection left the click looking dead ('s field case).
    const html = markup(opening);
    expect(door(html)).toContain('aria-busy="true"');
    expect(door(html)).toContain("disabled");
    expect(html).toContain('role="status"');
    expect(prose(html)).toContain("Reading geometry choices…");
    expect(html).toContain("data-set-geometry-panel");
  });
  it("closed, the door is live and no reading line stands", () => {
    const html = markup(CLOSED_STATE);
    expect(door(html)).not.toContain("aria-busy");
    expect(door(html)).not.toContain("disabled");
    expect(prose(html)).not.toContain("Reading the dataset");
  });
  it("the door is the list pages' add button: the same class, an icon before the label", () => {
    const heading = renderToStaticMarkup(<ListHeading title="Data" line={null} action={{ label: "Add data", onClick: () => {} }} />);
    const addClass = heading.match(/<button[^>]*class="([^"]*)"/)?.[1];
    expect(addClass).toBeTruthy();
    const html = markup(CLOSED_STATE);
    expect(door(html)).toContain(`class="${addClass}"`);
    expect(html).toMatch(/data-set-geometry-door="primary"[^>]*><svg[\s\S]*?<\/svg>Set geometry<\/button>/);
    // The slot's other state, a spatial dataset's Add to a map, wears the
    // same button, its own icon before the label.
    vi.mocked(useAsync).mockReturnValue({ state: { status: "ready", value: { ...table, geometryColumn: "geometry", geometryType: "LINESTRING" } }, retry: vi.fn() });
    vi.mocked(useSetGeometryPanel).mockReturnValue({ state: CLOSED_STATE, controller, open: vi.fn(), openByAddress: vi.fn() });
    const spatial = renderToStaticMarkup(<TableDetailScreen name="trips" />);
    const add = spatial.match(/<button[^>]*data-add-to-map="primary"[^>]*>/)?.[0] ?? "";
    expect(add).toContain(`class="${addClass}"`);
    expect(spatial).toMatch(/data-add-to-map="primary"[^>]*><svg[\s\S]*?<\/svg>Add to a map<\/button>/);
    expect(spatial).not.toContain('data-set-geometry-door="primary"');
  });
});
