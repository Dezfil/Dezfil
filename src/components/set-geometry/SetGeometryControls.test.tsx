import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { GeometryCandidate } from "@/lib/geometry-evidence";
import { AMBIGUOUS_PAIR } from "./derivations";
import { CLOSED_STATE, type PanelController, type PanelState } from "./panel-controller";
import { SetGeometryControls } from "./SetGeometryControls";
import type { GeometryInspection } from "./types";

/**
 * The one presentation option the shared controls gain: the ambiguous-pair hint, which tells the
 * person to swap the columns if the map is wrong, can be omitted by a surface that draws no map.
 * The dataset panel's default is unchanged. The pair here is genuinely ambiguous, its candidate
 * evidence listing both orientations, so the absence assertion can fail.
 */
const controller = {
  getState: () => CLOSED_STATE, subscribe: () => () => {}, configure: vi.fn(), open: vi.fn(), openByAddress: vi.fn(), setFormat: vi.fn(), setColumn: vi.fn(),
  swap: vi.fn(), chooseProjection: vi.fn(), typeOtherCode: vi.fn(), apply: vi.fn(), cancel: vi.fn(), dismiss: vi.fn(),
} as unknown as PanelController;
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
const state: PanelState = {
  ...CLOSED_STATE, phase: "open", inspection, mode: "first",
  choice: { format: "pair", columns: ["a", "b"], projection: { kind: "implicit", code: null, text: "" } },
};
const text = (h: string) => h.replace(/<[^>]+>/g, "");

describe("the shared controls' pair hint option (unchanged)", () => {
  it("by default, the hint shows for a pair whose candidate evidence lists both orientations: the dataset panel's behavior as merged", () => {
    const h = renderToStaticMarkup(<SetGeometryControls state={state} controller={controller} />);
    expect(text(h)).toContain(AMBIGUOUS_PAIR);
  });
  it("asked to omit it, the same ambiguous pair renders no hint and no replacement copy, with the pair fields and the swap still there", () => {
    const h = renderToStaticMarkup(<SetGeometryControls state={state} controller={controller} pairHint={false} />);
    expect(text(h)).not.toContain(AMBIGUOUS_PAIR);
    expect(text(h)).not.toContain("swap");
    expect(text(h)).toContain("Longitude · x");
    expect(text(h)).toContain("Latitude · y");
    expect(h).toContain('aria-label="Swap the two columns"');
  });
});
