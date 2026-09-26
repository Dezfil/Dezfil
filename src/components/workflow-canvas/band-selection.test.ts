import { describe, it, expect } from "vitest";
import type { OperationDef } from "@/lib/operations/catalog";
import type { TableListing } from "../api";
import type { WorkflowStep } from "../workflow-model";
import { canvasGraph, type CanvasMember, type NodeMember, type SourceMember } from "./graph";
import { addToMapFor, availability, effectiveTab, leadFor, NOTES, notesFor, resolveShown, SELECT_LEAD, STATUS } from "./band-selection";

const OPS = [{ id: "sql_step", label: "SQL step", group: "Data", symbol: "code", inputs: [], outputGeometry: { kind: "probed" } }] as unknown as OperationDef[];
const table = (id: string, name: string, geometryColumn: string | null): TableListing =>
  ({ id, name, geometryColumn, geometryType: geometryColumn ? "POINT" : null, rowCount: 3, importedAt: "2026-08-26T10:00:00Z" }) as unknown as TableListing;
const step = (o: Partial<WorkflowStep> & { id: string }): WorkflowStep => ({
  ordinal: 0, operation: "sql_step", parameters: { sql: "SELECT 1", name: `${o.id}_out` }, proposedParameters: null, output: null, reads: [],
  condition: "never_run", conditions: ["never_run"], causes: [], missingInputs: [], inputs: [], latestAttempt: null, lastSuccessAt: null, ...o,
});
const graphOf = (steps: WorkflowStep[], tables: TableListing[], sources: Record<string, { x: number; y: number }> = {}) =>
  canvasGraph({ steps, layout: { steps: {}, sources }, tables, operations: OPS });
const nodeOf = (g: ReturnType<typeof canvasGraph>, id: string) => g.members.find((m) => m.id === id) as NodeMember;
const sourceOf = (g: ReturnType<typeof canvasGraph>, name: string) => g.members.find((m) => m.kind === "source" && m.name === name) as SourceMember;

describe("the band's selection", () => {
  it("with nothing selected, the three tabs are unavailable with the sentence and the band falls to Messages", () => {
    const shown = resolveShown(null, []);
    expect(shown).toEqual({ kind: "nothing" });
    const a = availability(shown);
    expect(a).toEqual({ data: SELECT_LEAD, map: SELECT_LEAD, provenance: SELECT_LEAD });
    expect(effectiveTab("data", a)).toBe("messages");
    expect(effectiveTab("provenance", a)).toBe("messages");
    expect(leadFor(null)).toBeNull();
    expect(addToMapFor(shown)).toEqual({ kind: "absent" });
  });

  it("a never-run node has no output: Data carries the sentence, Map and Provenance fall to it, no action", () => {
    const g = graphOf([step({ id: "a" })], []);
    const shown = resolveShown(nodeOf(g, "a"), []);
    expect(shown).toEqual({ kind: "unproduced" });
    expect(STATUS.unproduced).toEqual({ big: "No output yet", small: "Run the node to see its rows here." });
    const a = availability(shown);
    expect(a).toEqual({ data: null, map: "Nothing has run yet", provenance: "Nothing has run yet" });
    expect(effectiveTab("map", a)).toBe("data");
    expect(effectiveTab("provenance", a)).toBe("data");
    expect(effectiveTab("messages", a)).toBe("messages");
    expect(addToMapFor(shown)).toEqual({ kind: "absent" });
    expect(leadFor(nodeOf(g, "a"))).toEqual({ kind: "node", label: "SQL step", dataset: "a_out" });
  });

  it("a node's dataset is its output by id; a table registered under the declared name since is not it", () => {
    const produced = step({ id: "a", output: { id: "o1", name: "a_out" }, conditions: ["current"], lastSuccessAt: "2026-08-26T10:00:00Z" });
    const live = [table("o1", "a_out", "geometry")];
    const g = graphOf([produced], live);
    const shown = resolveShown(nodeOf(g, "a"), live);
    expect(shown.kind).toBe("dataset");
    expect(shown.kind === "dataset" && shown.table.id).toBe("o1");
    // Deleted: the id is gone from the listing, and a stranger carries the name.
    const reclaimed = [table("o9", "a_out", "geometry")];
    const g2 = graphOf([produced], reclaimed);
    const gone = resolveShown(nodeOf(g2, "a"), reclaimed);
    expect(gone).toEqual({ kind: "deleted" });
    expect(availability(gone)).toEqual({ data: null, map: "The dataset is gone", provenance: "The dataset is gone" });
    expect(addToMapFor(gone)).toEqual({ kind: "absent" });
    expect(STATUS.deleted.big).toBe("This dataset no longer exists.");
  });

  it("Map and Add to a map follow the geometry column; a table without one says why", () => {
    const spatial = resolveShown(null, []);
    void spatial;
    const withGeom = { kind: "dataset", table: table("o1", "pts", "geometry") } as const;
    expect(availability(withGeom)).toEqual({ data: null, map: null, provenance: null });
    expect(effectiveTab("map", availability(withGeom))).toBe("map");
    expect(addToMapFor(withGeom)).toEqual({ kind: "available", name: "pts" });
    const plain = { kind: "dataset", table: table("o2", "counts", null) } as const;
    expect(availability(plain).map).toBe("No geometry in this dataset, so there is nothing to map.");
    expect(effectiveTab("map", availability(plain))).toBe("data");
    expect(addToMapFor(plain)).toEqual({ kind: "unavailable", reason: "No geometry: a table, not a layer." });
  });

  it("a source is the table under its name whichever way it came: read, lineage only, or loose; a missing one says so", () => {
    const live = [table("s1", "stations", "geometry"), table("s2", "loose_one", null), table("s3", "old_input", "geometry")];
    // The pending edit reads stations where the last run read old_input: the
    // recorded lineage stays on the canvas as a lineage-only source.
    const reader = step({
      id: "a", parameters: { sql: "SELECT * FROM old_input", name: "a_out" }, proposedParameters: { sql: "SELECT * FROM stations", name: "a_out" },
      output: { id: "o_a", name: "a_out" }, conditions: ["current"], reads: ["stations"], inputs: [{ id: "s3", name: "old_input" }],
    });
    const g = graphOf([reader], live, { loose_one: { x: 0, y: 0 } });
    const read = sourceOf(g, "stations");
    expect(read.loose).toBe(false);
    expect(resolveShown(read, live)).toEqual({ kind: "dataset", table: live[0] });
    const loose = sourceOf(g, "loose_one");
    expect(loose.loose).toBe(true);
    expect(resolveShown(loose, live)).toEqual({ kind: "dataset", table: live[1] });
    const lineage = sourceOf(g, "old_input");
    expect(lineage.lineageOnly).toBe(true);
    expect(resolveShown(lineage, live)).toEqual({ kind: "dataset", table: live[2] });
    expect(leadFor(read)).toEqual({ kind: "source", name: "stations" });
    // Missing: the graph says so from the listing, and the band repeats it.
    const g2 = graphOf([step({ id: "b", parameters: { sql: "SELECT * FROM gone", name: "b_out" }, reads: ["gone"] })], live);
    const missing = sourceOf(g2, "gone");
    expect(missing.missing).toBe(true);
    const shown = resolveShown(missing, live);
    expect(shown).toEqual({ kind: "missing" });
    expect(availability(shown)).toEqual({ data: null, map: "The table is gone", provenance: "The table is gone" });
    expect(STATUS.missing.big).toBe("This table no longer exists.");
    expect(notesFor(read, resolveShown(read, live))).toEqual([]);
    // The listing as last read decides: a table imported since the graph was
    // built is present the moment the listing holds it, whatever the graph's flag.
    expect(resolveShown(missing, [...live, table("s4", "gone", "geometry")])).toEqual({ kind: "dataset", table: table("s4", "gone", "geometry") });
  });

  it("the notes compose: every fact that holds, in the disclosure's order", () => {
    const live = [table("o1", "a_out", "geometry")];
    const both = step({ id: "a", output: { id: "o1", name: "a_out" }, conditions: ["stale"], proposedParameters: { sql: "SELECT 2", name: "a_out" } });
    const g = graphOf([both], live);
    expect(notesFor(nodeOf(g, "a"), resolveShown(nodeOf(g, "a"), live))).toEqual([NOTES.stale, NOTES.edited]);
    const failed = step({ id: "a", output: { id: "o1", name: "a_out" }, conditions: ["current"], latestAttempt: { state: "failed", error: { code: "x", message: "Boom." } } });
    expect(notesFor(nodeOf(graphOf([failed], live), "a"), { kind: "dataset", table: live[0] })).toEqual([NOTES.failed]);
    const cancelled = step({ id: "a", output: { id: "o1", name: "a_out" }, conditions: ["current"], latestAttempt: { state: "cancelled" } });
    expect(notesFor(nodeOf(graphOf([cancelled], live), "a"), { kind: "dataset", table: live[0] })).toEqual([NOTES.cancelled]);
    // The member's own wait in the run in flight, first; a succeeded member wears none.
    const running = graphOf([both], live);
    const m: CanvasMember = { ...nodeOf(running, "a"), run: { word: "queued", tone: "muted", reason: null } };
    expect(notesFor(m, { kind: "dataset", table: live[0] })).toEqual([NOTES.inFlight, NOTES.stale, NOTES.edited]);
    const done: CanvasMember = { ...nodeOf(running, "a"), run: { word: "up to date", tone: "ok", reason: null } };
    expect(notesFor(done, { kind: "dataset", table: live[0] })).toEqual([NOTES.stale, NOTES.edited]);
    // No dataset, no notes: the state row speaks instead.
    expect(notesFor(m, { kind: "unproduced" })).toEqual([]);
  });
});
