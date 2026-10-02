import { describe, it, expect } from "vitest";
import type { OperationDef } from "@/lib/operations/catalog";
import type { TableListing } from "../api";
import type { WorkflowStep } from "../workflow-model";
import { canvasGraph, conditionWords, type CanvasEdge } from "./graph";

const OPS = [
  { id: "sql_step", label: "SQL", group: "Data", symbol: "code", inputs: [] },
  {
    id: "spatial_join",
    label: "Spatial join",
    group: "Overlay",
    symbol: "join",
    inputs: [
      { name: "left", label: "Left" },
      { name: "right", label: "Right" },
    ],
  },
  { id: "buffer", label: "Buffer", group: "Proximity", symbol: "buffer", inputs: [{ name: "input", label: "Input" }] },
] as unknown as OperationDef[];

const table = (name: string, geometryType: string | null = "POINT"): TableListing =>
  ({ id: `t_${name}`, name, geometryType, rowCount: 3 }) as unknown as TableListing;

const step = (o: Partial<WorkflowStep> & { id: string; operation: string; parameters: Record<string, unknown> }): WorkflowStep => ({
  ordinal: 0,
  proposedParameters: null,
  output: null,
  reads: [],
  condition: "never_run",
  conditions: ["never_run"],
  causes: [],
  missingInputs: [],
  inputs: [],
  latestAttempt: null,
  lastSuccessAt: null,
  ...o,
});

const graph = (steps: WorkflowStep[], over: Partial<Parameters<typeof canvasGraph>[0]> = {}) =>
  canvasGraph({
    steps,
    layout: { steps: {}, sources: {} },
    tables: [table("stations"), table("districts", "POLYGON"), table("cafes"), table("stations_500m")],
    operations: OPS,
    ...over,
  });

const edge = (g: ReturnType<typeof canvasGraph>, to: string, table: string): CanvasEdge[] =>
  g.edges.filter((e) => e.to === to && e.table === table);

describe("the canvas graph", () => {
  it("draws a node per step, a source per present external read, and edges into labelled ports or the SQL side (c)", () => {
    const g = graph([
      step({ id: "a", ordinal: 0, operation: "buffer", parameters: { input: "stations", name: "stations_500m" }, reads: ["stations"] }),
      step({ id: "b", ordinal: 1, operation: "sql_step", parameters: { sql: "SELECT * FROM stations_500m JOIN districts", name: "reach" }, reads: ["stations_500m", "districts"] }),
    ]);
    const kinds = g.members.map((m) => `${m.kind}:${m.kind === "node" ? m.id : m.name}`);
    expect(kinds).toEqual(["source:stations", "source:districts", "node:a", "node:b"]);
    expect(edge(g, "a", "stations")[0]).toMatchObject({ from: "src:stations", attachment: { kind: "port", port: "input" }, time: "present", broken: false, stale: false });
    expect(edge(g, "b", "stations_500m")[0]).toMatchObject({ from: "a", attachment: { kind: "sql" }, time: "present" });
    expect(edge(g, "b", "districts")[0]).toMatchObject({ from: "src:districts", attachment: { kind: "sql" } });
    const b = g.members.find((m) => m.kind === "node" && m.id === "b");
    expect(b && b.kind === "node" && b.sql).toBe(true);
    expect(b && b.kind === "node" && b.ports).toEqual([]);
    // The present external reads: stations and districts, not the node's own output.
    expect(g.presentSourceCount).toBe(2);
  });

  it("names the output as the dataset once produced and the declared name before, and the ports' effective values", () => {
    const g = graph([
      step({ id: "a", operation: "buffer", parameters: { input: "stations", name: "declared" }, reads: ["stations"] }),
      step({ id: "b", ordinal: 1, operation: "buffer", parameters: { input: "stations", name: "was_declared" }, output: { id: "o", name: "produced" }, reads: ["stations"], condition: "current", conditions: ["current"], lastSuccessAt: "2026-08-25T08:00:00Z" }),
    ]);
    const [a, b] = g.members.filter((m) => m.kind === "node");
    expect(a.kind === "node" && a.outputName).toBe("declared");
    expect(b.kind === "node" && b.outputName).toBe("produced");
    expect(a.kind === "node" && a.ports).toEqual([{ name: "input", label: "Input", value: "stations" }]);
  });

  it("finds a producer by the name the registry gives it, so a read of the sanitized name is an edge, not a missing source", () => {
    const g = graph([
      step({ id: "a", ordinal: 0, operation: "buffer", parameters: { input: "stations", name: "2024 Trips" }, reads: ["stations"] }),
      step({ id: "b", ordinal: 1, operation: "sql_step", parameters: { sql: "SELECT * FROM t2024_trips", name: "later" }, reads: ["t2024_trips"] }),
    ]);
    expect(edge(g, "b", "t2024_trips")[0]).toMatchObject({ from: "a", broken: false });
    expect(g.members.filter((m) => m.kind === "source").map((m) => m.kind === "source" && m.name)).toEqual(["stations"]);
    expect(g.presentSourceCount).toBe(1);
  });

  it("attaches a named-input node's built-from edge to the port that read it, and carries a stale cause on it", () => {
    const g = graph([
      step({
        id: "b",
        operation: "buffer",
        parameters: { input: "stations", name: "b_out" },
        proposedParameters: { input: "cafes", name: "b_out" },
        output: { id: "o", name: "b_out" },
        reads: ["cafes"],
        inputs: [{ id: "t_stations", name: "stations" }],
        condition: "stale",
        conditions: ["stale"],
        causes: [{ reason: "source_changed", tableId: "t_stations", tableName: "stations" }],
      }),
    ]);
    expect(edge(g, "b", "cafes")[0]).toMatchObject({ time: "proposed", attachment: { kind: "port", port: "input" } });
    expect(edge(g, "b", "stations")[0]).toMatchObject({ time: "lineage", attachment: { kind: "port", port: "input" }, stale: true });
  });

  it("draws two edges from one table into two ports, and a pending change to one of them as one proposed edge", () => {
    const g = graph([
      step({
        id: "j",
        operation: "spatial_join",
        parameters: { left: "stations", right: "stations", name: "self_join" },
        proposedParameters: { left: "stations", right: "cafes", name: "self_join" },
        output: { id: "o", name: "self_join" },
        reads: ["stations", "cafes"],
        inputs: [{ id: "t_stations", name: "stations" }],
        condition: "current",
        conditions: ["current"],
      }),
    ]);
    const into = g.edges.filter((e) => e.to === "j");
    expect(into.map((e) => [e.table, (e.attachment as { port: string }).port, e.time])).toEqual([
      ["stations", "left", "present"],
      ["cafes", "right", "proposed"],
    ]);
    // Two ports set to one table are two edges.
    const g2 = graph([
      step({ id: "j", operation: "spatial_join", parameters: { left: "stations", right: "stations", name: "self_join" }, reads: ["stations"] }),
    ]);
    expect(g2.edges.filter((e) => e.to === "j").map((e) => (e.attachment as { port: string }).port)).toEqual(["left", "right"]);
  });

  it("marks a pending SQL read of a new table proposed and keeps the table it left as a built-from lineage edge", () => {
    const g = graph([
      step({
        id: "q",
        operation: "sql_step",
        parameters: { sql: "SELECT * FROM stations", name: "q_out" },
        proposedParameters: { sql: "SELECT * FROM cafes", name: "q_out" },
        output: { id: "o", name: "q_out" },
        reads: ["cafes"],
        inputs: [{ id: "t_stations", name: "stations" }],
        condition: "current",
        conditions: ["current"],
      }),
    ]);
    expect(edge(g, "q", "cafes")[0]).toMatchObject({ time: "proposed", attachment: { kind: "sql" } });
    expect(edge(g, "q", "stations")[0]).toMatchObject({ time: "lineage", from: "src:stations" });
    const stations = g.members.find((m) => m.kind === "source" && m.name === "stations");
    expect(stations).toMatchObject({ lineageOnly: true, missing: false });
    // The lineage-only source is drawn beyond the present count.
    expect(g.presentSourceCount).toBe(1);
  });

  it("draws a missing source with a broken edge, from the API's word or a successful listing's silence, never from an unread listing", () => {
    const reported = graph([
      step({ id: "a", operation: "buffer", parameters: { input: "gone", name: "x" }, reads: ["gone"], condition: "broken", conditions: ["broken", "never_run"], missingInputs: [{ tableId: "t_gone", tableName: "gone" }] }),
    ]);
    expect(reported.members.find((m) => m.kind === "source")).toMatchObject({ name: "gone", missing: true, table: null });
    expect(edge(reported, "a", "gone")[0].broken).toBe(true);
    // The listing lacks it, the recipe has not said so ('s shape).
    const silent = graph([step({ id: "a", operation: "buffer", parameters: { input: "gone", name: "x" }, reads: ["gone"] })]);
    expect(silent.members.find((m) => m.kind === "source")?.kind === "source" && silent.members.find((m) => m.kind === "source")).toMatchObject({ missing: true });
    // The listing was never read: not missing on that account.
    const unread = graph([step({ id: "a", operation: "buffer", parameters: { input: "gone", name: "x" }, reads: ["gone"] })], { tables: null });
    expect(unread.members.find((m) => m.kind === "source")).toMatchObject({ missing: false });
    // A producer upstream that is broken does not make the produced table a missing source.
    const through = graph([
      step({ id: "a", ordinal: 0, operation: "buffer", parameters: { input: "gone", name: "mid" }, reads: ["gone"], condition: "broken", conditions: ["broken", "never_run"], missingInputs: [{ tableId: "t_gone", tableName: "gone" }] }),
      step({ id: "b", ordinal: 1, operation: "buffer", parameters: { input: "mid", name: "end" }, reads: ["mid"], condition: "broken", conditions: ["broken", "never_run"], missingInputs: [{ tableId: "t_mid", tableName: "mid", throughStepId: "a" }] }),
    ]);
    expect(through.members.filter((m) => m.kind === "source").map((m) => m.kind === "source" && m.name)).toEqual(["gone"]);
    expect(edge(through, "b", "mid")[0]).toMatchObject({ from: "a", broken: false });
  });

  it("draws stale only on the edges the causes name", () => {
    const g = graph([
      step({
        id: "j",
        operation: "spatial_join",
        parameters: { left: "stations", right: "districts", name: "joined" },
        output: { id: "o", name: "joined" },
        reads: ["stations", "districts"],
        inputs: [{ id: "t_stations", name: "stations" }, { id: "t_districts", name: "districts" }],
        condition: "stale",
        conditions: ["stale"],
        causes: [{ reason: "source_changed", tableId: "t_districts", tableName: "districts" }],
      }),
    ]);
    expect(edge(g, "j", "stations")[0].stale).toBe(false);
    expect(edge(g, "j", "districts")[0].stale).toBe(true);
  });

  it("counts present external sources as the summary does and draws lineage-only and loose sources beyond it", () => {
    const g = graph(
      [
        step({ id: "a", ordinal: 0, operation: "buffer", parameters: { input: "stations", name: "stations_500m" }, reads: ["stations"] }),
        step({ id: "b", ordinal: 1, operation: "sql_step", parameters: { sql: "x", name: "reach" }, proposedParameters: { sql: "y", name: "reach" }, output: { id: "o", name: "reach" }, reads: ["stations_500m"], inputs: [{ id: "t_districts", name: "districts" }], condition: "current", conditions: ["current"] }),
      ],
      { layout: { steps: {}, sources: { cafes: { x: 0, y: 0 } } } },
    );
    const names = g.members.filter((m) => m.kind === "source").map((m) => m.kind === "source" && `${m.name}${m.loose ? ":loose" : ""}${m.lineageOnly ? ":lineage" : ""}`);
    expect(names).toEqual(["stations", "districts:lineage", "cafes:loose"]);
    expect(g.presentSourceCount).toBe(1);
  });

  it("a run node whose pending edit names an absent table draws the source missing and a broken proposed edge, badged as the API says", () => {
    const g = graph([
      step({
        id: "q",
        operation: "sql_step",
        parameters: { sql: "SELECT * FROM stations", name: "q_out" },
        proposedParameters: { sql: "SELECT * FROM vanished", name: "q_out" },
        output: { id: "o", name: "q_out" },
        reads: ["vanished"],
        inputs: [{ id: "t_stations", name: "stations" }],
        condition: "current",
        conditions: ["current"],
      }),
    ]);
    expect(g.members.find((m) => m.kind === "source" && m.name === "vanished")).toMatchObject({ missing: true });
    expect(edge(g, "q", "vanished")[0]).toMatchObject({ time: "proposed", broken: true });
    const q = g.members.find((m) => m.kind === "node");
    expect(q?.kind === "node" && q.state.word).toBe("edited");
  });

  it("wears one state in the page's precedence with the badge the specimen gives it, and discloses every condition and the last successful run", () => {
    const at = "2026-08-25T08:00:00Z";
    const cases: [Partial<WorkflowStep>, string, string | null][] = [
      [{ latestAttempt: { state: "queued" }, conditions: ["broken"], condition: "broken" }, "queued", null],
      [{ latestAttempt: { state: "running" } }, "running", "spinner"],
      [{ conditions: ["broken", "never_run"], condition: "broken", latestAttempt: { state: "failed" } }, "cannot run", "warn"],
      [{ conditions: ["stale"], condition: "stale", latestAttempt: { state: "failed" } }, "run failed", "warn"],
      [{ conditions: ["output_missing", "stale"], condition: "output_missing" }, "output deleted", "rerun"],
      [{ conditions: ["output_unavailable"], condition: "output_unavailable" }, "output not available", null],
      [{ conditions: ["stale"], condition: "stale", proposedParameters: { a: 1 } }, "stale", "rerun"],
      [{ conditions: ["current"], condition: "current", proposedParameters: { a: 1 } }, "edited", "edit"],
      [{ conditions: ["never_run"], condition: "never_run" }, "never run", null],
      [{ conditions: ["current"], condition: "current", latestAttempt: { state: "cancelled" }, lastSuccessAt: at }, "up to date", "check"],
    ];
    for (const [over, word, badge] of cases) {
      const g = graph([step({ id: "n", operation: "buffer", parameters: { input: "stations", name: "n_out" }, reads: ["stations"], ...over })]);
      const n = g.members.find((m) => m.kind === "node");
      expect(n?.kind === "node" && n.state.word, word).toBe(word);
      expect(n?.kind === "node" && n.state.badge, word).toBe(badge);
    }
    // The disclosure names every condition true of it, and the last run.
    const s = step({ id: "n", operation: "buffer", parameters: { input: "stations", name: "n_out" }, reads: ["stations"], conditions: ["stale"], condition: "stale", latestAttempt: { state: "failed" }, proposedParameters: { input: "cafes", name: "n_out" }, output: { id: "o", name: "n_out" }, lastSuccessAt: at });
    expect(conditionWords(s)).toEqual(["stale", "run failed", "edited"]);
    const n = graph([s]).members.find((m) => m.kind === "node");
    expect(n?.kind === "node" && n.disclosure).toMatch(/^Buffer · n_out · stale, run failed, edited · last successful run /);
    const never = graph([step({ id: "n", operation: "buffer", parameters: { input: "stations", name: "n_out" }, reads: ["stations"] })]).members.find((m) => m.kind === "node");
    expect(never?.kind === "node" && never.disclosure).toBe("Buffer · n_out · never run · never run successfully");
  });
});

/** a step whose operation the catalog does not serve
 * carries an unknown key, so its surfaces wear the fallback pictogram —
 * never the SQL drawing it used to borrow. */
describe("a step off the catalog", () => {
  it("carries an unknown symbol and its operation name as the label", () => {
    const g = graph([step({ id: "s9", operation: "retired_verb", parameters: {} })]);
    const m = g.members.find((x) => x.id === "s9");
    expect(m).toMatchObject({ kind: "node", symbol: "unknown_operation", label: "retired_verb" });
  });
});
