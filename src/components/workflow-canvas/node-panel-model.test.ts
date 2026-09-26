import { describe, it, expect } from "vitest";
import type { OperationDef } from "@/lib/operations/catalog";
import type { TableListing } from "../api";
import type { WorkflowStep } from "../workflow-model";
import { canvasGraph, type NodeMember } from "./graph";
import { callouts, changedValues, currentOption, downstreamOf, pickerOptions, showValue, unproducedOutput } from "./node-panel-model";

const OPS = [
  { id: "sql_step", label: "SQL step", group: "Data", symbol: "code", inputs: [], outputGeometry: { kind: "probed" } },
  {
    id: "buffer",
    label: "Buffer",
    group: "Proximity",
    symbol: "buffer",
    inputs: [{ name: "input", label: "Features to buffer", accepts: ["point", "line", "polygon"], required: true }],
    outputGeometry: { kind: "fixed", geometry: "polygon" },
    availability: { available: false, reason: "The routing engine is not configured." },
  },
] as unknown as OperationDef[];
const table = (name: string, geometryType: string | null): TableListing =>
  ({ id: `t_${name}`, name, geometryType, geometryColumn: geometryType ? "geom" : null, rowCount: 1 }) as unknown as TableListing;
const TABLES = [table("stations", "POINT"), table("cafes", null), table("b_out", "POLYGON")];
const step = (o: Partial<WorkflowStep> & { id: string; operation: string; parameters: Record<string, unknown> }): WorkflowStep => ({
  ordinal: 0, proposedParameters: null, output: null, reads: [], condition: "never_run", conditions: ["never_run"],
  causes: [], missingInputs: [], inputs: [], latestAttempt: null, lastSuccessAt: null, ...o,
});
const graphOf = (steps: WorkflowStep[]) => canvasGraph({ steps, layout: { steps: {}, sources: {} }, tables: TABLES, operations: OPS });
const node = (g: ReturnType<typeof canvasGraph>, id: string) => g.members.find((m) => m.id === id) as NodeMember;

describe("the node panel's callouts", () => {
  it("orders them as discloses: in flight, cannot run, unavailable, failed, cancelled, deleted, stale, edited", () => {
    const g = graphOf([
      step({
        id: "b", operation: "buffer", parameters: { input: "stations", distance: 100, name: "b_out" },
        proposedParameters: { input: "stations", distance: 250, name: "b_out" },
        output: { id: "o", name: "b_out" }, conditions: ["broken", "output_missing", "stale"],
        missingInputs: [{ tableId: "x", tableName: "gone" }], causes: [{ reason: "source_changed", tableId: "t", tableName: "stations" }],
        latestAttempt: { state: "failed", error: { code: "x", message: "Boom." } },
      }),
    ]);
    const keys = callouts(node(g, "b"), OPS[1]).map((c) => c.key);
    expect(keys).toEqual(["broken", "unavailable", "failed", "output_missing", "stale", "edited"]);
    const failed = callouts(node(g, "b"), OPS[1]).find((c) => c.key === "failed")!;
    expect(failed.body).toBe("The previous output stands.");
    expect(failed.mono).toBe("Boom.");
    const edited = callouts(node(g, "b"), OPS[1]).find((c) => c.key === "edited")!;
    expect(edited.changes).toEqual([{ name: "distance", was: "100", now: "250" }]);
  });

  it("puts a run in flight first and says nothing for a plain never-run node", () => {
    const g = graphOf([
      step({ id: "q", operation: "sql_step", parameters: { sql: "SELECT 1", name: "q_out" }, latestAttempt: { state: "running" } }),
      step({ id: "n", ordinal: 1, operation: "sql_step", parameters: { sql: "SELECT 2", name: "n_out" } }),
    ]);
    expect(callouts(node(g, "q"), OPS[0]).map((c) => c.key)).toEqual(["running"]);
    expect(callouts(node(g, "n"), OPS[0])).toEqual([]);
  });
});

describe("changed values and shown values", () => {
  it("names each changed value old and new, lists and aggregates in words", () => {
    const s = step({
      id: "s", operation: "sql_step",
      parameters: { bands: [1, 2], carry: [{ aggregate: "sum", field: "pop" }], flag: true, name: "x" },
      proposedParameters: { bands: [1, 2, 3], carry: [{ aggregate: "count" }], flag: true, name: "x" },
    });
    expect(changedValues(s)).toEqual([
      { name: "bands", was: "1, 2", now: "1, 2, 3" },
      { name: "carry", was: "sum(pop)", now: "count" },
    ]);
    expect(showValue(undefined)).toBe("not set");
    expect(showValue([])).toBe("none");
  });
});

describe("the input picker", () => {
  it("offers accepted members first, names each refused one's reason, then the tables not on the canvas", () => {
    const g = graphOf([
      step({ id: "b", operation: "buffer", parameters: { input: "stations", name: "b_out" }, reads: ["stations"] }),
      step({ id: "q", ordinal: 1, operation: "sql_step", parameters: { sql: "SELECT * FROM cafes", name: "q_out" }, reads: ["cafes"] }),
      step({ id: "b2", ordinal: 2, operation: "buffer", parameters: { name: "b2_out" } }),
    ]);
    const options = pickerOptions({ to: node(g, "b2"), port: "input", graph: g, operations: OPS, tables: TABLES });
    // stations (point) and b's polygon output and the probed q_out are accepted; cafes holds no
    // geometry.
    expect(options.accepted.map((o) => o.name)).toEqual(["b_out", "q_out", "stations"]);
    expect(options.refused.map((o) => [o.name, o.reason !== null])).toEqual([["cafes", true]]);
    expect(options.elsewhere).toEqual([]);
    // b2 itself is never offered to itself.
    expect([...options.accepted, ...options.refused].some((o) => o.name === "b2_out")).toBe(false);
  });

  it("classifies a workspace table off the canvas under the same rules", () => {
    const g = graphOf([step({ id: "b2", operation: "buffer", parameters: { name: "b2_out" } })]);
    const options = pickerOptions({ to: node(g, "b2"), port: "input", graph: g, operations: OPS, tables: TABLES });
    // stations and b_out (point, polygon) are offered; cafes has no geometry: refused with the
    // reason.
    expect(options.elsewhere.map((o) => o.name)).toEqual(["b_out", "stations"]);
    expect(options.refused.map((o) => o.name)).toEqual(["cafes"]);
    expect(options.refused[0].reason).toMatch(/holds no geometry/);
  });

  it("carries each row's glyph kind and fact, lists an unnamed output by its node under the refusals, and shows a current value the groups lost", () => {
    const g = graphOf([
      step({ id: "b", operation: "buffer", parameters: { input: "stations", name: "b_out" }, reads: ["stations"] }),
      step({ id: "u", ordinal: 1, operation: "buffer", parameters: { input: "stations" }, reads: ["stations"] }),
      step({ id: "b2", ordinal: 2, operation: "buffer", parameters: { name: "b2_out" } }),
    ]);
    const options = pickerOptions({ to: node(g, "b2"), port: "input", graph: g, operations: OPS, tables: TABLES });
    const stations = options.accepted.find((o) => o.name === "stations")!;
    expect([stations.kind, stations.fact, stations.node]).toEqual(["point", "1 rows", false]);
    const bOut = options.accepted.find((o) => o.name === "b_out")!;
    expect([bOut.kind, bOut.fact, bOut.node]).toEqual(["polygon", "node", true]);
    const unnamed = options.refused.find((o) => o.fact === "not named")!;
    expect([unnamed.name, unnamed.label, unnamed.node]).toEqual(["", "Buffer", true]);
    expect(unnamed.reason).toMatch(/no name yet/);
    const cafes = options.refused.find((o) => o.name === "cafes")!;
    expect([cafes.kind, cafes.fact]).toEqual(["none", "1 rows"]);
    expect(currentOption("stations", options)).toBe(stations);
    expect(currentOption(null, options)).toBeNull();
    const gone = currentOption("vanished", options)!;
    expect([gone.name, gone.fact, gone.kind]).toEqual(["vanished", "missing", "unknown"]);
    expect(gone.reason).toMatch(/not on the canvas or in the workspace/);
  });

  it("knows an unproduced output from a produced one", () => {
    const g = graphOf([
      step({ id: "b", operation: "buffer", parameters: { input: "stations", name: "b_out" }, output: { id: "o", name: "b_out" } }),
      step({ id: "q", ordinal: 1, operation: "sql_step", parameters: { sql: "SELECT 1", name: "q_out" } }),
    ]);
    expect(unproducedOutput("b_out", g, TABLES)).toBe(false);
    expect(unproducedOutput("q_out", g, TABLES)).toBe(true);
    expect(unproducedOutput("stations", g, TABLES)).toBe(false);
    expect(unproducedOutput(null, g, TABLES)).toBe(false);
  });
});

describe("the nodes after a node", () => {
  it("counts every node downstream by the present reads, transitively, not the node itself", () => {
    const g = graphOf([
      step({ id: "a", ordinal: 0, operation: "buffer", parameters: { input: "stations", name: "a_out" }, reads: ["stations"] }),
      step({ id: "b", ordinal: 1, operation: "buffer", parameters: { input: "a_out", name: "b_out" }, reads: ["a_out"] }),
      step({ id: "c", ordinal: 2, operation: "sql_step", parameters: { sql: "SELECT * FROM b_out", name: "c_out" }, reads: ["b_out"] }),
      step({ id: "d", ordinal: 3, operation: "sql_step", parameters: { sql: "SELECT 1", name: "d_out" }, reads: [] }),
    ]);
    expect(downstreamOf(g, "a").map((m) => m.id).sort()).toEqual(["b", "c"]);
    expect(downstreamOf(g, "c")).toEqual([]);
    expect(downstreamOf(g, "d")).toEqual([]);
  });
});

