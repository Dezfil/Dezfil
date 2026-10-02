import { describe, it, expect } from "vitest";
import type { OperationDef } from "@/lib/operations/catalog";
import type { TableListing } from "../api";
import type { WorkflowStep } from "../workflow-model";
import { canvasGraph, type SourceMember } from "./graph";
import { addToMapFor, resolveShown } from "./band-selection";

/**
 * A reached workflow read by someone other than its home's account. Ada's
 * workflow, homed in her space, reads `roads` by its plain name: her
 * dataset. Bo, an Editor, reaches it and owns a `roads` of his own; his
 * listing holds both, his own typed `roads` and hers typed `ada.roads`. The
 * canvas must draw, read and open hers, whichever order the listing has.
 */

const OPS = [
  { id: "sql_step", label: "SQL", group: "Data", symbol: "code", inputs: [] },
  { id: "buffer", label: "Buffer", group: "Proximity", symbol: "buffer", inputs: [{ name: "input", label: "Input" }] },
] as unknown as OperationDef[];

const listed = (id: string, owner: string, typed: string, rowCount: number, geometryColumn: string | null = "geom"): TableListing =>
  ({
    id, name: typed.slice(typed.lastIndexOf(".") + 1), qualifiedName: typed, owner: { name: owner, sqlName: owner },
    rowCount, geometryColumn, geometryType: geometryColumn ? "POINT" : null, importedAt: "2026-10-01T10:00:00Z",
  }) as unknown as TableListing;

const step = (o: Partial<WorkflowStep> & { id: string; operation: string; parameters: Record<string, unknown> }): WorkflowStep => ({
  ordinal: 0, proposedParameters: null, output: null, reads: [], condition: "never_run", conditions: ["never_run"],
  causes: [], missingInputs: [], inputs: [], latestAttempt: null, lastSuccessAt: null, ...o,
});

const hers = listed("t_ada_roads", "ada", "ada.roads", 7);
const his = listed("t_bo_roads", "bo", "roads", 2);
const reading = (read: string) => [
  step({ id: "a", operation: "sql_step", parameters: { sql: `SELECT * FROM ${read}`, name: "roads_out" }, reads: [read] }),
];
const sourceIn = (g: ReturnType<typeof canvasGraph>, name: string) =>
  g.members.find((m) => m.kind === "source" && m.name === name) as SourceMember;

describe("the canvas's listing on a workflow homed in someone else's space", () => {
  for (const [label, tables] of [["his own listed first", [his, hers]], ["hers listed first", [hers, his]]] as const) {
    it(`draws the home's dataset for a plain name, not the reader's same-named one (${label})`, () => {
      const g = canvasGraph({ steps: reading("roads"), layout: { steps: {}, sources: {} }, tables: [...tables], operations: OPS, home: "ada" });
      const source = sourceIn(g, "roads");
      expect(source.missing).toBe(false);
      expect(source.table?.rowCount).toBe(7);
      expect(source.tableId).toBe("t_ada_roads");
      expect(source.typedName).toBe("ada.roads");
      const shown = resolveShown(source, [...tables]);
      expect(shown.kind === "dataset" && shown.table.id).toBe("t_ada_roads");
      expect(addToMapFor(shown)).toEqual({ kind: "available", name: "ada.roads" });
    });
  }

  it("draws the reader's own dataset for a name qualified with the reader's SQL name, typed as the reader types it", () => {
    const g = canvasGraph({
      steps: [step({ id: "a", operation: "buffer", parameters: { input: "bo.roads", name: "near" }, reads: ["bo.roads"] })],
      layout: { steps: {}, sources: {} }, tables: [hers, his], operations: OPS, home: "ada",
    });
    const source = sourceIn(g, "bo.roads");
    expect(source.tableId).toBe("t_bo_roads");
    expect(source.typedName).toBe("roads");
    expect(source.table?.rowCount).toBe(2);
    const shown = resolveShown(source, [hers, his]);
    expect(addToMapFor(shown)).toEqual({ kind: "available", name: "roads" });
  });

  it("says the home's dataset is missing when only the reader's same-named one is listed, and opens nothing", () => {
    const g = canvasGraph({ steps: reading("roads"), layout: { steps: {}, sources: {} }, tables: [his], operations: OPS, home: "ada" });
    const source = sourceIn(g, "roads");
    expect(source.missing).toBe(true);
    expect(source.table).toBeNull();
    expect(source.typedName).toBeNull();
    expect(resolveShown(source, [his])).toEqual({ kind: "missing" });
  });

  it("keeps the home's own reading for its owner: a plain name is theirs, typed plain", () => {
    const own = listed("t_ada_roads", "ada", "roads", 7);
    const other = listed("t_bo_roads", "bo", "bo.roads", 2);
    const g = canvasGraph({ steps: reading("roads"), layout: { steps: {}, sources: {} }, tables: [other, own], operations: OPS, home: "ada" });
    const source = sourceIn(g, "roads");
    expect(source.tableId).toBe("t_ada_roads");
    expect(source.typedName).toBe("roads");
  });

  it("keeps two qualified reads of one person apart: the dataset part is no file extension", () => {
    const rivers = listed("t_bo_rivers", "bo", "rivers", 4);
    const g = canvasGraph({
      steps: [step({ id: "a", operation: "sql_step", parameters: { sql: "SELECT 1", name: "both" }, reads: ["bo.roads", "bo.rivers"] })],
      layout: { steps: {}, sources: {} }, tables: [hers, his, rivers], operations: OPS, home: "ada",
    });
    const sources = g.members.filter((m): m is SourceMember => m.kind === "source");
    expect(sources.map((m) => [m.name, m.tableId])).toEqual([["bo.roads", "t_bo_roads"], ["bo.rivers", "t_bo_rivers"]]);
    expect(new Set(sources.map((m) => m.id)).size).toBe(2);
    expect(g.presentSourceCount).toBe(2);
  });

  it("never takes a qualified read for a node's output that its sanitized form happens to spell", () => {
    const g = canvasGraph({
      steps: [
        step({ id: "p", ordinal: 0, operation: "sql_step", parameters: { sql: "SELECT 1", name: "bo" }, reads: [] }),
        step({ id: "q", ordinal: 1, operation: "buffer", parameters: { input: "bo.roads", name: "near" }, reads: ["bo.roads"] }),
      ],
      layout: { steps: {}, sources: {} }, tables: [hers, his], operations: OPS, home: "ada",
    });
    const into = g.edges.filter((e) => e.to === "q");
    expect(into).toHaveLength(1);
    expect(into[0].from).not.toBe("p");
    expect(sourceIn(g, "bo.roads").tableId).toBe("t_bo_roads");
  });
});
