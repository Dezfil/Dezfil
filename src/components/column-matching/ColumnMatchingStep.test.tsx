import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { GeometryCandidate } from "@/lib/geometry-evidence";
import { AMBIGUOUS_PAIR } from "../set-geometry/derivations";
import { CLOSED_STATE, type PanelController, type PanelState } from "../set-geometry/panel-controller";
import { KEEP_SENTENCE } from "../set-geometry/SetGeometryPanel";
import type { GeometryInspection, GeometryPreview } from "../set-geometry/types";
import { ColumnMatchingStep } from "./ColumnMatchingStep";
import type { MatchingStep, MatchingStepState } from "./matching-step";

/**
 * The step's frame: the controls column with
 * the note under it, the grid heading naming the API's sample, the
 * reused grid with the picks tagged and the unreadable rows marked, and
 * the footer with the first-apply sentence, Cancel and Confirm. Markup
 * only; the look is the field round's.
 */
const controller = {
  getState: () => CLOSED_STATE, subscribe: () => () => {}, configure: vi.fn(), open: vi.fn(), openByAddress: vi.fn(), setFormat: vi.fn(), setColumn: vi.fn(),
  swap: vi.fn(), chooseProjection: vi.fn(), typeOtherCode: vi.fn(), apply: vi.fn(), cancel: vi.fn(), dismiss: vi.fn(),
} as unknown as PanelController;
const step = { getState: () => CLOSED_STATE, subscribe: () => () => {}, controller, configure: vi.fn(), open: vi.fn(), confirm: vi.fn(), cancel: vi.fn() } as unknown as MatchingStep;
const ambiguous: GeometryCandidate = {
  columns: ["a", "b"], format: "pair", signal: "content", rule: "content", strength: "weak",
  sample: { rows: 3, nonNull: 3, readable: 3 }, crs: { stance: "assumed", srid: null, label: "WGS 84 assumed" },
  degreeCompatible: true, reasons: [], applied: false, sourceRetained: true,
  orientations: [{ lon: "a", lat: "b" }, { lon: "b", lat: "a" }],
};
const inspection: GeometryInspection = {
  tableId: "t", revision: "r1", columns: [{ name: "id", type: "BIGINT" }, { name: "a", type: "DOUBLE" }, { name: "b", type: "DOUBLE" }],
  geometryColumn: null, geometryRecord: null, currentChoice: null, mode: "unmodified", candidates: [ambiguous],
};
const answer: GeometryPreview = {
  tableId: "t", revision: "r1", choice: { format: "pair", columns: ["a", "b"] }, canApply: true, issues: [], rowCount: 3, unreadableCount: 1, geometryType: "POINT",
  extent: [8, 50, 9, 51], degreeCompatible: true,
  sample: {
    rows: [
      { index: 0, values: { id: 1, a: 8.57, b: 50.05 }, status: "readable" },
      { index: 1, values: { id: 2, a: null, b: 50.06 }, status: "unreadable" },
    ],
    features: { type: "FeatureCollection", features: [] },
  },
};
const key = "r1|" + JSON.stringify({ format: "pair", columns: ["a", "b"] });
const open: PanelState = {
  ...CLOSED_STATE, phase: "open", inspection, mode: "first",
  choice: { format: "pair", columns: ["a", "b"], projection: { kind: "implicit", code: null, text: "" } },
  preview: { status: "ready", key, answerKey: key, answerRecord: null, message: null, answer },
};
const state = (panel: PanelState, over: Partial<MatchingStepState> = {}): MatchingStepState => ({ panel, confirmable: false, busy: false, resolved: null, ...over });
const html = (s: MatchingStepState, waiting: string[] = []) => renderToStaticMarkup(<ColumnMatchingStep state={s} step={step} waiting={waiting} />);
const text = (h: string) => h.replace(/<[^>]+>/g, "");
const order = (h: string, parts: string[]) => parts.map((p) => h.indexOf(p)).every((at, i, all) => at >= 0 && (i === 0 || at > all[i - 1]));

describe("the column-matching step's frame", () => {
  it("the controls come first with the format and the pair, then the grid under its heading, then the footer with the first-apply sentence, Cancel and Confirm", () => {
    const h = html(state(open));
    expect(order(h, [">Format<", "Longitude · x", "Latitude · y", "Preview of the first 2 rows", "<table", KEEP_SENTENCE, "Cancel", "Confirm"])).toBe(true);
    expect(h).toContain('aria-label="Swap the two columns"');
    expect(h).toContain('aria-label="Projection"');
  });
  it("the ambiguous-pair hint is absent from the step, for a pair whose candidate evidence lists both orientations", () => {
    expect(text(html(state(open)))).not.toContain(AMBIGUOUS_PAIR);
  });
  it("the grid shows the answer's own rows with the chosen columns tagged and the unreadable row marked; the heading names the sample's count", () => {
    const h = html(state(open));
    expect(text(h)).toContain("Preview of the first 2 rows");
    expect(h.match(/data-pick="true"/g)?.length).toBe(2 + 2 * 2);
    expect(h).toContain(">longitude<");
    expect(h).toContain(">latitude<");
    expect(h.match(/<tr data-bad="true">/g)).toHaveLength(1);
    expect(h).toContain("8.57");
  });
  it("the note names the files waiting behind this one, and is absent when nothing waits", () => {
    expect(text(html(state(open)))).not.toContain("wait for this step");
    expect(text(html(state(open), ["berlin_addresses_utm.csv", "rhein_main_stations.csv"]))).toContain("2 more files wait for this step: berlin_addresses_utm.csv, rhein_main_stations.csv");
    expect(text(html(state(open), ["rhein_main_stations.csv"]))).toContain("1 more file waits for this step: rhein_main_stations.csv");
  });
  it("Confirm follows the step's gate; while the set is in flight Cancel is inert and Confirm says it is busy", () => {
    expect(html(state(open))).toMatch(/<button[^>]*disabled[^>]*>Confirm<\/button>/);
    expect(html(state(open, { confirmable: true }))).not.toMatch(/<button[^>]*disabled[^>]*>Confirm<\/button>/);
    const busy = html(state({ ...open, applying: true }, { busy: true }));
    expect(busy).toMatch(/<button[^>]*disabled[^>]*>Cancel<\/button>/);
    expect(busy).toMatch(/<button[^>]*aria-busy="true"[^>]*>/);
  });
  it("a refusal renders in the kit's error note, as the API worded it, with the controls still there", () => {
    const h = html(state({ ...open, refusal: "A geometry edit or refresh is already running for this dataset or import group." }));
    expect(h).toContain('role="alert"');
    expect(text(h)).toContain("A geometry edit or refresh is already running for this dataset or import group.");
    expect(h).toContain('aria-label="Swap the two columns"');
    const unopened = html(state({ ...CLOSED_STATE, openError: "The source of this dataset cannot carry a geometry choice." }));
    expect(text(unopened)).toContain("The source of this dataset cannot carry a geometry choice.");
    expect(text(unopened)).toContain("Cancel");
  });
  it("while the inspection is in flight the frame stands with its footer and no controls, Confirm off", () => {
    const h = html(state({ ...CLOSED_STATE, phase: "opening" }));
    expect(h).not.toContain(">Format<");
    expect(text(h)).toContain("Preview");
    expect(h).toMatch(/<button[^>]*disabled[^>]*>Confirm<\/button>/);
  });
});
