import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { GeometryRecord } from "@/lib/geometry-evidence";
import { crsEvidence } from "@/lib/ingest/content-decoders";
import type { TableInspection } from "./api";
import { TableDetailScreen } from "./TableDetailScreen";
import { useAsync } from "./ui/AsyncState";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/data/trajectories" }));
vi.mock("./ui/AsyncState", async original => ({
  ...await original<typeof import("./ui/AsyncState")>(), useAsync: vi.fn(),
}));
vi.mock("./builder/drawer/use-recipes", () => ({ useRecipes: () => ({ recipes: [], error: null, reload: vi.fn() }) }));
vi.mock("./TablePreviewMap", () => ({ TablePreviewMap: () => null }));
vi.mock("./shell/PlainCrumbTail", () => ({ PlainCrumbTail: () => null }));

const table: TableInspection = {
  id: "fixture", name: "trajectories", sourceFilename: "trips.csv", file: "tables/fixture.parquet",
  format: "csv", geometryColumn: "geometry", geometryType: "LINESTRING", crsAssumed: true,
  headerSuspect: false, rowCount: 1000, source: "upload", sourceParams: null,
  createdAt: "2026-09-13T10:00:00Z", importedAt: "2026-09-13T10:00:00Z",
  columns: [], preview: [], sizeBytes: 1024, projectIds: [], inputs: null,
  owner: { name: "Ada", sqlName: "ada" }, qualifiedName: "trajectories",
};
function markup(record?: GeometryRecord | null, source: TableInspection["source"] = "upload"): string {
  vi.mocked(useAsync).mockReturnValue({ state: { status: "ready", value: { ...table, source, crsAssumed: record?.crs.stance === "assumed", geometryRecord: record } }, retry: vi.fn() });
  return renderToStaticMarkup(<TableDetailScreen name={table.name} />);
}
const cases: [GeometryRecord["format"], string, GeometryRecord["crs"]][] = [
  ["wkt", "WKT text", { stance: "assumed", srid: null, label: "WGS 84 assumed" }],
  ["wkt", "WKT text", { stance: "declared", srid: 4326, label: "WGS 84" }],
  ["wkt", "WKT text", { stance: "declared", srid: 3857, label: "Web Mercator (EPSG:3857)" }],
  ["geojson", "GeoJSON", { stance: "inherent", srid: 4326, label: "WGS 84" }],
  ["wkb", "WKB hex", { stance: "assumed", srid: null, label: "WGS 84 assumed" }],
  ["wkb", "WKB hex", { stance: "declared", srid: 25832, label: "ETRS89 / UTM 32N (EPSG:25832)" }],
  ["h3", "H3 cell", { stance: "inherent", srid: 4326, label: "WGS 84" }],
  ["pair", "Coordinate pair", { stance: "assumed", srid: null, label: "WGS 84 assumed" }],
];
it.each(cases)("the actual dataset provenance renders %s with %s and its recorded CRS", (format, label, crs) => {
  const columns = format === "pair" ? ["start_x", "start_y"] : ["column01"];
  const html = markup({ columns, format, signal: "content", rule: "content", crs, unreadableCount: 0 });
  const prose = html.replace(/<[^>]+>/g, "");
  expect(prose).toContain(`Geometry: ${columns.join(", ")} read as ${label}, ${crs.label}`);
  expect(prose).toContain("Uploaded as trips.csv");
  expect(prose).toContain("last run");
  expect(prose.indexOf("Uploaded as trips.csv")).toBeLessThan(prose.indexOf("Geometry:"));
  expect(prose.indexOf("Geometry:")).toBeLessThan(prose.indexOf("last run"));
  // The Change door: in the record line of a file
  // upload or URL import with a record, and nowhere else.
  expect(html).toMatch(/Geometry:.*<button[^>]*>Change<\/button>/);
  expect(prose.indexOf("Change")).toBeLessThan(prose.indexOf("last run"));
  expect(markup({ columns, format, signal: "content", rule: "content", crs, unreadableCount: 0 }, "url")).toContain(">Change<");
  expect(markup({ columns, format, signal: "content", rule: "content", crs, unreadableCount: 0 }, "operation")).not.toContain(">Change<");
  expect(markup({ columns, format, signal: "content", rule: "content", crs, unreadableCount: 0 }, "sketch")).not.toContain(">Change<");
});
it("legacy provenance is not invented and source column text is escaped", () => {
  expect(markup()).not.toContain("Geometry:");
  expect(markup(null)).not.toContain("Geometry:");
  // A legacy dataset without a record has no record line and no door.
  expect(markup()).not.toContain(">Change<");
  expect(markup(null)).not.toContain(">Change<");
  const html = markup({ columns: ["<script>wrong</script>"], format: "wkt", signal: "content", rule: "content", crs: cases[0][2], unreadableCount: 0 });
  expect(html).toContain("&lt;script&gt;wrong&lt;/script&gt;");
  expect(html).not.toContain("<script>wrong</script>");
});

it("the assumed chip is a door on an eligible dataset page, the shipped chip elsewhere, and absent when the flag is off", () => {
  const assumed: GeometryRecord = { columns: ["column01"], format: "wkt", signal: "content", rule: "content", crs: { stance: "assumed", srid: null, label: "WGS 84 assumed" }, unreadableCount: 0 };
  expect(markup(assumed, "upload")).toMatch(/<button[^>]*data-set-geometry-door="crs"[^>]*>WGS84 assumed/);
  expect(markup(assumed, "url")).toContain('data-set-geometry-door="crs"');
  const operation = markup(assumed, "operation");
  expect(operation).toContain(">WGS84 assumed<");
  expect(operation).not.toContain('data-set-geometry-door="crs"');
  const declared = markup({ ...assumed, crs: { stance: "declared", srid: 4326, label: "WGS 84" } }, "upload");
  expect(declared).not.toContain("WGS84 assumed");
});

it("a No geometry upload or URL import carries Set geometry in the primary slot; other sources and spatial datasets do not", () => {
  const none = (source: TableInspection["source"], candidates?: TableInspection["geometryCandidates"]) => {
    vi.mocked(useAsync).mockReturnValue({ state: { status: "ready", value: { ...table, source, geometryColumn: null, geometryType: null, crsAssumed: false, geometryCandidates: candidates } }, retry: vi.fn() });
    return renderToStaticMarkup(<TableDetailScreen name={table.name} />);
  };
  expect(none("upload")).toMatch(/<button[^>]*data-set-geometry-door="primary"[^>]*>.*?Set geometry<\/button>/);
  expect(none("url")).toContain('data-set-geometry-door="primary"');
  expect(none("sketch")).not.toContain("Set geometry");
  expect(none("operation")).not.toContain("Set geometry");
  const spatial = markup({ columns: ["column01"], format: "wkt", signal: "content", rule: "content", crs: cases[0][2], unreadableCount: 0 }, "upload");
  expect(spatial).toContain(">Add to a map<");
  expect(spatial).not.toContain('data-set-geometry-door="primary"');
  // The strip: a weak pair candidate proposes; a weak non-pair one shows the doors and no strip; a
  // strong one no strip.
  const pair = { columns: ["column06", "column07"], format: "pair" as const, signal: "content" as const, rule: "content" as const, strength: "weak" as const, sample: { rows: 20, nonNull: 20, readable: 20 }, crs: cases[0][2], degreeCompatible: true, reasons: [], applied: false, sourceRetained: true, orientations: [{ lon: "column07", lat: "column06" }] };
  const strip = none("upload", [pair]);
  expect(strip).toContain("data-proposal-strip");
  expect(strip.replace(/<[^>]+>/g, "")).toContain("column07 and column06 look like coordinates.");
  expect(strip).toContain('data-set-geometry-door="primary"');
  expect(none("upload", [{ ...pair, columns: ["column01"], format: "wkt", orientations: undefined }])).not.toContain("data-proposal-strip");
  expect(none("upload", [{ ...pair, strength: "strong" }])).not.toContain("data-proposal-strip");
  expect(none("sketch", [pair])).not.toContain("data-proposal-strip");
});

it("Berlin declared EWKT provenance names ETRS89 / UTM 33N and EPSG:25833", () => {
  const html = markup({ columns: ["shape"], format: "wkt", signal: "content", rule: "content",
    crs: crsEvidence("wkt", [25833]), unreadableCount: 0 });
  expect(html.replace(/<[^>]+>/g, "")).toContain("Geometry: shape read as WKT text, ETRS89 / UTM 33N (EPSG:25833)");
  expect(html).not.toContain("assumed");
});
