import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { GeometryCandidate } from "@/lib/geometry-evidence";
import { NOT_DEGREES, AMBIGUOUS_PAIR } from "./derivations";
import { CLOSED_STATE, type PanelController, type PanelState } from "./panel-controller";
import { KEEP_SENTENCE, SetGeometryPanel } from "./SetGeometryPanel";
import type { GeometryInspection, GeometryPreview, PanelChoice } from "./types";

const controller = {
  getState: () => CLOSED_STATE, subscribe: () => () => {}, configure: vi.fn(), open: vi.fn(), openByAddress: vi.fn(), setFormat: vi.fn(), setColumn: vi.fn(),
  swap: vi.fn(), chooseProjection: vi.fn(), typeOtherCode: vi.fn(), apply: vi.fn(), cancel: vi.fn(), dismiss: vi.fn(),
} as unknown as PanelController;
const inspection: GeometryInspection = {
  tableId: "t", revision: "r1", columns: [{ name: "id", type: "BIGINT" }, { name: "column01", type: "VARCHAR" }, { name: "x", type: "DOUBLE" }, { name: "y", type: "DOUBLE" }],
  geometryColumn: null, geometryRecord: null, currentChoice: null, mode: "unmodified", candidates: [],
};
const wkt: PanelChoice = { format: "wkt", columns: ["column01"], projection: { kind: "implicit", code: null, text: "" } };
function answer(statuses: GeometryPreview["sample"]["rows"][number]["status"][], over: Partial<GeometryPreview> = {}): GeometryPreview {
  return { tableId: "t", revision: "r1", choice: { format: "wkt", columns: ["column01"] }, canApply: true, issues: [], rowCount: 20, unreadableCount: 3,
    geometryType: "POINT", extent: [8, 50, 9, 51], degreeCompatible: true,
    sample: { rows: statuses.map((status, index) => ({ index, values: {}, status })), features: { type: "FeatureCollection", features: [] } }, ...over };
}
function state(over: Partial<PanelState>): PanelState {
  return { ...CLOSED_STATE, phase: "open", inspection, choice: wkt, mode: "first", ...over };
}
const html = (s: PanelState) => renderToStaticMarkup(<SetGeometryPanel name="trajectories_september" state={s} controller={controller} />);
const text = (h: string) => h.replace(/<[^>]+>/g, "");
const order = (h: string, parts: string[]) => parts.map((p) => h.indexOf(p)).every((at, i, all) => at >= 0 && (i === 0 || at > all[i - 1]));

describe("the set-geometry panel's controls (03 P and C)", () => {
  it("the header names the dataset and the controls come in the drawn order, the five formats first", () => {
    const h = html(state({}));
    expect(text(h)).toContain("Set geometry");
    expect(text(h)).toContain("trajectories_september");
    expect(order(h, ["Coordinate pair", "WKT text", "GeoJSON", "WKB hex", "H3 cell"])).toBe(true);
    expect(order(h, [">Format<", ">Column<", ">Projection", "Cancel", "Apply"])).toBe(true);
    expect(h).toContain('aria-pressed="true"');
    expect(h.match(/aria-pressed="true"/g)).toHaveLength(1);
  });
  it("the footer sentence is present on a first apply and absent on a change", () => {
    expect(text(html(state({ mode: "first" })))).toContain(KEEP_SENTENCE);
    expect(text(html(state({ mode: "change" })))).not.toContain(KEEP_SENTENCE);
  });
  it("the projection field is absent for H3 and GeoJSON and present for the others", () => {
    for (const format of ["h3", "geojson"] as const) expect(html(state({ choice: { ...wkt, format } }))).not.toContain("Projection");
    for (const format of ["pair", "wkt", "wkb"] as const) expect(html(state({ choice: { ...wkt, format, columns: format === "pair" ? ["x", "y"] : ["column01"] } }))).toContain("Projection");
  });
  it("the pair shows both fields with the swap; the hint shows only when the candidate lists both orientations", () => {
    const pair: PanelChoice = { ...wkt, format: "pair", columns: ["x", "y"] };
    const candidate = (orientations: { lon: string; lat: string }[]): GeometryCandidate => ({ columns: ["x", "y"], format: "pair", signal: "content", rule: "content", strength: "weak",
      sample: { rows: 20, nonNull: 20, readable: 20 }, crs: { stance: "assumed", srid: null, label: "WGS 84 assumed" }, degreeCompatible: true, reasons: [], applied: false, sourceRetained: true, orientations });
    const both = html(state({ choice: pair, inspection: { ...inspection, candidates: [candidate([{ lon: "x", lat: "y" }, { lon: "y", lat: "x" }])] } }));
    expect(text(both)).toContain("Longitude · x");
    expect(text(both)).toContain("Latitude · y");
    expect(both).toContain('aria-label="Swap the two columns"');
    expect(text(both)).toContain(AMBIGUOUS_PAIR);
    const one = html(state({ choice: pair, inspection: { ...inspection, candidates: [candidate([{ lon: "x", lat: "y" }])] } }));
    expect(text(one)).not.toContain(AMBIGUOUS_PAIR);
  });
  it("the not-degrees notice marks the projection field; Other EPSG code reveals the code field; an issue shows the API's sentence", () => {
    const pair: PanelChoice = { ...wkt, format: "pair", columns: ["x", "y"] };
    const berlin = html(state({ choice: pair, preview: { status: "ready", key: "k", answerKey: "k", message: null, answerRecord: null, answer: answer(["projection-required"], { canApply: false, geometryType: null, issues: [{ code: "projection_required", message: "api words" }] }) } }));
    expect(text(berlin)).toContain(NOT_DEGREES);
    expect(berlin).toContain("data-attn");
    expect(text(berlin)).toContain("0 of 1 sampled rows can be read.");
    expect(berlin).toContain("Other EPSG code…");
    expect(berlin).not.toContain("EPSG code, for example 31467");
    const other = html(state({ choice: { ...pair, projection: { kind: "other", code: null, text: "" } } }));
    expect(other).toContain("EPSG code, for example 31467");
    const unsupported = html(state({ choice: pair, preview: { status: "ready", key: "k", answerKey: "k", message: null, answerRecord: null, answer: answer(["unreadable"], { canApply: false, issues: [{ code: "unsupported_projection", message: "EPSG:999999 cannot be transformed to WGS 84." }] }) } }));
    expect(text(unsupported)).toContain("EPSG:999999 cannot be transformed to WGS 84.");
    expect(text(unsupported)).not.toContain(NOT_DEGREES);
  });
  it("the native path's field is marked and holds no code", () => {
    const h = html(state({ marked: true, choice: { ...wkt, format: "wkb", columns: ["geometry"], projection: { kind: "unset", code: null, text: "" } }, inspection: { ...inspection, geometryColumn: "geometry", columns: [...inspection.columns, { name: "geometry", type: "GEOMETRY" }] } }));
    expect(h).toContain("data-attn");
    expect(h).toMatch(/<option value="" selected="">Choose a projection<\/option>/);
    expect(h).toMatch(/<option value="geometry" selected="">geometry · GEOMETRY<\/option>/);
  });
  it("the count sentence carries the unreadable clause with the sample's exact count, and Apply follows the gate", () => {
    const ready = state({ preview: { status: "ready", key: "r1|" + JSON.stringify({ format: "wkt", columns: ["column01"] }), answerKey: "r1|" + JSON.stringify({ format: "wkt", columns: ["column01"] }), message: null, answerRecord: null,
      answer: answer(["readable", "readable", "unreadable", "missing", "readable", "unreadable", "unreadable"]) } });
    const h = html(ready);
    expect(text(h)).toContain("3 of 7 sampled rows read as points.");
    expect(text(h)).toContain("3 could not be read. They keep no geometry.");
    expect(h).toMatch(/<button[^>]*data-variant="primary"[^>]*><svg/);
    const pending = html(state({ preview: { status: "pending", key: "k", answerKey: null, message: null, answerRecord: null, answer: null } }));
    expect(pending).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*?Apply: checking…<\/button>/);
  });
  it("a refusal renders in the kit's error note, as worded, with the panel still open", () => {
    const h = html(state({ refusal: "A geometry edit or refresh is already running for this dataset or import group." }));
    expect(h).toContain('role="alert"');
    expect(text(h)).toContain("A geometry edit or refresh is already running for this dataset or import group.");
    expect(text(h)).toContain("Apply");
  });
  it("closed, it renders nothing", () => {
    expect(html(CLOSED_STATE)).toBe("");
  });
  it("opened from the chip, the marked field holds no chosen code and offers WGS 84 as a choice to make", () => {
    const h = html(state({ marked: true }));
    expect(h).toContain("data-attn");
    expect(h).toMatch(/<option value="" selected="">Choose a projection<\/option>/);
    expect(h).toMatch(/<option value="4326">WGS 84 \(EPSG:4326\)<\/option>/);
    expect(h).not.toMatch(/<option value="4326" selected="">/);
  });
  it("each format button's accessible name is its label with the example still shown; the projection field and the code field are named apart", () => {
    const h = html(state({ choice: { ...wkt, format: "pair", columns: ["x", "y"], projection: { kind: "other", code: null, text: "" } } }));
    for (const label of ["Coordinate pair", "WKT text", "GeoJSON", "WKB hex", "H3 cell"]) expect(h).toContain(`aria-label="${label}"`);
    expect(text(h)).toContain("POINT(…), LINESTRING(…)");
    expect(h).toMatch(/<select[^>]*aria-label="Projection"[^>]*data-field="projection"/);
    expect(h).toContain('aria-label="EPSG code"');
  });
});

describe("field round: geometry progress", () => {
  it("shows the opening work in the dock", () => {
    const h = html(state({ phase: "opening", inspection: null }));
    expect(h).toContain('role="status"');
    expect(text(h)).toContain("Reading geometry choices…");
    expect(text(h)).not.toContain(KEEP_SENTENCE);
    expect(text(h)).toContain("Apply: loading…");
  });
  it("shows checking and gives disabled Apply a waiting reason", () => {
    const h = html(state({ preview: { ...CLOSED_STATE.preview, status: "pending" } }));
    expect(h).toContain('role="status"');
    expect(text(h)).toContain("Checking the rows…");
    expect(h).not.toContain('title="Waiting for the row check to finish."');
    expect(h).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*?Apply: checking…/);
  });
  it("shows applying work and keeps Apply's icon beside a visible busy sign", () => {
    const h = html(state({ applying: true }));
    expect(h).toContain('role="status"');
    expect(text(h)).toContain("Writing geometry for all rows…");
    const button = h.match(/<button[^>]*aria-busy="true"[\s\S]*?<\/button>/)?.[0] ?? "";
    expect(button).toContain("<svg");
    expect(button).toContain('data-tone="current"');
    expect(text(button)).toContain("Applying…");
  });
  it("shows failed check and apply sentences verbatim, without ongoing work", () => {
    for (const over of [{ preview: { ...CLOSED_STATE.preview, status: "failed" as const, message: "The API check failed." } }, { refusal: "The API set failed." }]) {
      const h = html(state(over));
      expect(h).toContain('role="alert"');
      expect(text(h)).toContain(over.refusal ?? over.preview?.message);
      expect(text(h)).not.toContain("Checking the rows…");
      expect(text(h)).not.toContain("Writing geometry for all rows…");
    }
  });
});
