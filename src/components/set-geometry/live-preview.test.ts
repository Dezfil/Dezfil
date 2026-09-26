import { describe, expect, it } from "vitest";
import { livePreview } from "./live-preview";
import { CLOSED_STATE, type PanelState } from "./panel-controller";
import type { GeometryInspection, GeometryPreview } from "./types";

const columns = [{ name: "id", type: "BIGINT" }, { name: "column01", type: "VARCHAR" }];
const table = { columns, preview: [{ id: 1, column01: "LINESTRING(1 2, 3 4)" }] };
const inspection: GeometryInspection = { tableId: "t", revision: "r1", columns, geometryColumn: null, geometryRecord: null, currentChoice: null, mode: "unmodified", candidates: [] };
const answer: GeometryPreview = {
  tableId: "t", revision: "r1", choice: { format: "wkt", columns: ["column01"] }, canApply: true, issues: [], rowCount: 1000, unreadableCount: 0, geometryType: "LINESTRING",
  extent: [1, 2, 3, 4], degreeCompatible: true,
  sample: { rows: [{ index: 0, values: { id: 1, column01: "LINESTRING(1 2, 3 4)" }, status: "readable" }, { index: 1, values: { id: 2, column01: "bad" }, status: "unreadable" }], features: { type: "FeatureCollection", features: [] } },
};
const open: PanelState = {
  ...CLOSED_STATE, phase: "open", inspection,
  choice: { format: "wkt", columns: ["column01"], projection: { kind: "implicit", code: null, text: "" } },
  preview: { status: "ready", key: "k", answerKey: "k", message: null, answerRecord: null, answer },
};

describe("the Data preview while the panel is open", () => {
  it("shows the answer's rows on the inspection's columns, the chosen column tagged and the unreadable row marked", () => {
    expect(livePreview(open, table)).toEqual({ columns, rows: [answer.sample.rows[0].values, answer.sample.rows[1].values], tags: { column01: "geometry" }, marks: [false, true] });
  });
  it("closed, or open with no answer yet, the page's own preview stands untagged and unmarked", () => {
    expect(livePreview(CLOSED_STATE, table)).toEqual({ columns, rows: table.preview });
    expect(livePreview({ ...open, preview: { status: "idle", key: null, answerKey: null, message: null, answerRecord: null, answer: null } }, table)).toEqual({ columns, rows: table.preview });
  });
  it("the tags follow the answer's own choice while a replacement is pending, never the draft", () => {
    const drafted: PanelState = {
      ...open,
      choice: { format: "pair", columns: ["id", "column01"], projection: { kind: "implicit", code: null, text: "" } },
      preview: { status: "pending", key: "k2", answerKey: "k", message: null, answerRecord: null, answer },
    };
    expect(livePreview(drafted, table).tags).toEqual({ column01: "geometry" });
  });
});
