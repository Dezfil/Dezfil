import { describe, it, expect } from "vitest";
import type { OperationDef } from "@/lib/operations/catalog";
import type { TableListing } from "../api";
import type { WorkflowStep } from "../workflow-model";
import { canvasGraph } from "./graph";
import { acceptsClass, expectedClass, linkRefusal, reaches } from "./link-rules";

const OPS = [
  { id: "sql_step", label: "SQL step", group: "Data", symbol: "code", inputs: [], outputGeometry: { kind: "probed" } },
  {
    id: "buffer",
    label: "Buffer",
    group: "Proximity",
    symbol: "buffer",
    inputs: [{ name: "input", label: "Features to buffer", accepts: ["point", "line", "polygon"], required: true }],
    outputGeometry: { kind: "fixed", geometry: "polygon" },
  },
  {
    id: "measure_columns",
    label: "Measure",
    group: "Geometry",
    symbol: "measure",
    inputs: [{ name: "input", label: "Features", accepts: ["any"], required: true }],
    outputGeometry: { kind: "from_input", input: "input" },
  },
  {
    id: "geocode_addresses",
    label: "Geocode",
    group: "Data",
    symbol: "geo",
    inputs: [{ name: "input", label: "Rows", accepts: ["none"], required: true }],
    outputGeometry: { kind: "fixed", geometry: "point" },
  },
] as unknown as OperationDef[];

const table = (name: string, geometryType: string | null): TableListing =>
  ({ id: `t_${name}`, name, geometryType, geometryColumn: geometryType ? "geom" : null, rowCount: 1 }) as unknown as TableListing;
const TABLES = [table("stations", "POINT"), table("districts", "POLYGON"), table("cafes", null)];
// An empty spatial table: a geometry column, no rows to classify.
const EMPTY_SPATIAL = { ...table("empty_geo", null), geometryColumn: "geom" } as TableListing;

const step = (o: Partial<WorkflowStep> & { id: string; operation: string; parameters: Record<string, unknown> }): WorkflowStep => ({
  ordinal: 0, proposedParameters: null, output: null, reads: [], condition: "never_run", conditions: ["never_run"],
  causes: [], missingInputs: [], inputs: [], latestAttempt: null, lastSuccessAt: null, ...o,
});
// Districts sits on the canvas as a loose source: a member nothing reads yet.
const graphOf = (steps: WorkflowStep[]) =>
  canvasGraph({ steps, layout: { steps: {}, sources: { districts: { x: 0, y: 0 } } }, tables: TABLES, operations: OPS });
const member = (g: ReturnType<typeof canvasGraph>, id: string) => g.members.find((m) => m.id === id || (m.kind === "source" && m.name === id))!;

describe("the link rules", () => {
  it("accepts by the catalog's classes: any takes all, none takes no geometry, a probed class is accepted", () => {
    expect(acceptsClass(["any"], "none")).toBe(true);
    expect(acceptsClass(["none"], "point")).toBe(false);
    expect(acceptsClass(["none"], "none")).toBe(true);
    expect(acceptsClass(["point", "line"], "polygon")).toBe(false);
    expect(acceptsClass(["point", "line"], "unknown")).toBe(true);
    expect(acceptsClass(["point"], "none")).toBe(false);
  });

  it("knows a member's class before a run: the source's table, a fixed verb, a pass-through, a probed one unknown", () => {
    const g = graphOf([
      step({ id: "b", ordinal: 0, operation: "buffer", parameters: { input: "stations", name: "b_out" }, reads: ["stations"] }),
      step({ id: "m", ordinal: 1, operation: "measure_columns", parameters: { input: "b_out", name: "m_out" }, reads: ["b_out"] }),
      step({ id: "q", ordinal: 2, operation: "sql_step", parameters: { sql: "SELECT 1", name: "q_out" }, reads: [] }),
    ]);
    expect(expectedClass(member(g, "stations"), g, OPS, TABLES)).toBe("point");
    expect(expectedClass(member(g, "b"), g, OPS, TABLES)).toBe("polygon");
    expect(expectedClass(member(g, "m"), g, OPS, TABLES)).toBe("polygon");
    expect(expectedClass(member(g, "q"), g, OPS, TABLES)).toBe("unknown");
  });

  it("refuses the wrong class, a self-read, a loop and a missing source, and accepts a probed output", () => {
    const g = graphOf([
      step({ id: "b", ordinal: 0, operation: "buffer", parameters: { input: "stations", name: "b_out" }, reads: ["stations"] }),
      step({ id: "g", ordinal: 1, operation: "geocode_addresses", parameters: { input: "cafes", name: "g_out" }, reads: ["cafes"] }),
      step({ id: "q", ordinal: 2, operation: "sql_step", parameters: { sql: "SELECT * FROM b_out", name: "q_out" }, reads: ["b_out"] }),
      step({ id: "b2", ordinal: 3, operation: "buffer", parameters: { name: "b2_out" }, reads: ["gone"], missingInputs: [{ tableId: "x", tableName: "gone" }], condition: "broken", conditions: ["broken", "never_run"] }),
    ]);
    const into = (from: string, to: string, port = "input") =>
      linkRefusal({ from: member(g, from), to: member(g, to) as never, port, graph: g, operations: OPS, tables: TABLES });
    expect(into("cafes", "b")).toMatch(/needs point, line, polygon geometry; “cafes” holds no geometry/);
    expect(into("stations", "g")).toMatch(/takes a table without geometry; “stations” holds point geometry/);
    expect(into("b", "b")).toMatch(/cannot read its own output/);
    // q reads b's output; b reading q would loop.
    expect(into("q", "b")).toMatch(/make a loop/);
    expect(into("gone", "b")).toMatch(/does not exist/);
    // A probed output is accepted into a geometry input.
    expect(into("q", "b2")).toBeNull();
    expect(into("districts", "b")).toBeNull();
    expect(reaches(g, "q", "b")).toBe(true);
    expect(reaches(g, "b", "q")).toBe(false);
  });

  it("keeps an empty spatial table unknown, and accepted, rather than calling it a table without geometry", () => {
    const all = [...TABLES, EMPTY_SPATIAL];
    const g = canvasGraph({
      steps: [step({ id: "b", ordinal: 0, operation: "buffer", parameters: { name: "b_out" } })],
      layout: { steps: {}, sources: { empty_geo: { x: 0, y: 0 } } },
      tables: all,
      operations: OPS,
    });
    expect(expectedClass(member(g, "empty_geo"), g, OPS, all)).toBe("unknown");
    expect(linkRefusal({ from: member(g, "empty_geo"), to: member(g, "b") as never, port: "input", graph: g, operations: OPS, tables: all })).toBeNull();
  });
});
