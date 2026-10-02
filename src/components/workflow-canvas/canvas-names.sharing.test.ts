import { describe, it, expect } from "vitest";
import type { OperationDef } from "@/lib/operations/catalog";
import type { TableListing } from "../api";
import type { WorkflowStep } from "../workflow-model";
import { canvasGraph, type NodeMember } from "./graph";
import { expectedClass, memberByName } from "./link-rules";
import { currentOption, pickerOptions, unproducedOutput } from "./node-panel-model";
import { removalPlan } from "./removal-model";
import * as names from "./home-names";

/**
 * Two accounts and a workflow homed in one of them. Ada's workflow reads
 * plain names in her space. Bo, an Editor, reaches it and owns datasets
 * named like hers; his listing holds his own under their plain names and
 * hers qualified, `ada.roads`. Whatever the canvas offers, stores or
 * checks for him must be the dataset he chose, in either listing order: his
 * own is written `bo.roads` in her home, hers stays `roads`.
 */

const OPS = [
  { id: "sql_step", label: "SQL", group: "Data", symbol: "code", inputs: [], outputGeometry: { kind: "probed" } },
  {
    id: "filter_rows", label: "Filter rows", group: "Data", symbol: "filter",
    inputs: [{ name: "input", label: "Rows to filter", accepts: ["any"], required: true }],
    outputGeometry: { kind: "from_input", input: "input" },
  },
] as unknown as OperationDef[];

const listed = (id: string, owner: string, typed: string, rowCount: number, geometryType: string | null = "POINT"): TableListing =>
  ({
    id, name: typed.slice(typed.lastIndexOf(".") + 1), qualifiedName: typed, owner: { name: owner, sqlName: owner },
    rowCount, geometryColumn: geometryType ? "geom" : null, geometryType, importedAt: "2026-10-01T10:00:00Z",
  }) as unknown as TableListing;

const step = (o: Partial<WorkflowStep> & { id: string; operation: string; parameters: Record<string, unknown> }): WorkflowStep => ({
  ordinal: 0, proposedParameters: null, output: null, reads: [], condition: "never_run", conditions: ["never_run"],
  causes: [], missingInputs: [], inputs: [], latestAttempt: null, lastSuccessAt: null, ...o,
});

// Bo's listing: her roads are typed qualified, his own plain.
const hersForBo = listed("t_ada_roads", "ada", "ada.roads", 7, "LINESTRING");
const hisForBo = listed("t_bo_roads", "bo", "roads", 2, "POLYGON");
const ORDERS = [["his own listed first", [hisForBo, hersForBo]], ["hers listed first", [hersForBo, hisForBo]]] as const;

const filterNode = (input: string, extra: Partial<WorkflowStep> = {}) =>
  step({ id: "f", operation: "filter_rows", parameters: { input, name: "kept" }, reads: input ? [input] : [], ...extra });
const graphFor = (steps: WorkflowStep[], tables: readonly TableListing[], sources: Record<string, { x: number; y: number }> = {}) =>
  canvasGraph({ steps, layout: { steps: {}, sources }, tables: [...tables], operations: OPS, home: "ada" });
const nodeIn = (g: ReturnType<typeof canvasGraph>, id: string) => g.members.find((m) => m.id === id) as NodeMember;

describe("the input picker on a workflow homed in someone else's space", () => {
  for (const [label, tables] of ORDERS) {
    it(`offers the reader's own same-named dataset as their own, written for the home (${label})`, () => {
      const g = graphFor([filterNode("")], tables);
      const all = pickerOptions({ to: nodeIn(g, "f"), port: "input", graph: g, operations: OPS, tables: [...tables] });
      const offered = [...all.accepted, ...all.elsewhere].map((o) => [o.name, o.fact]);
      expect(offered).toEqual(expect.arrayContaining([["roads", "7 rows"], ["bo.roads", "2 rows"]]));
      expect(offered).toHaveLength(2);
    });

    it(`keeps offering the reader's own dataset when the home's same-named one is on the canvas (${label})`, () => {
      const g = graphFor([filterNode("")], tables, { roads: { x: 0, y: 0 } });
      const all = pickerOptions({ to: nodeIn(g, "f"), port: "input", graph: g, operations: OPS, tables: [...tables] });
      expect(all.accepted.map((o) => [o.name, o.fact])).toEqual([["roads", "7 rows"]]);
      expect(all.elsewhere.map((o) => [o.name, o.fact])).toEqual([["bo.roads", "2 rows"]]);
    });
  }

  it("finds the current value by the dataset it names: a qualified read is never a node's output its sanitized form spells", () => {
    const tables = [hersForBo, hisForBo];
    const g = graphFor(
      [
        step({ id: "p", operation: "sql_step", parameters: { sql: "SELECT 1", name: "bo" } }),
        filterNode("bo.roads", { ordinal: 1 }),
      ],
      tables,
    );
    const options = pickerOptions({ to: nodeIn(g, "f"), port: "input", graph: g, operations: OPS, tables });
    // The node `bo` and the dataset `bo.roads` are two rows, not one.
    expect(options.accepted.map((o) => o.name)).toEqual(["bo", "bo.roads"]);
    expect(currentOption("bo.roads", options)).toMatchObject({ name: "bo.roads", node: false, fact: "2 rows" });
    expect(currentOption("bo", options)).toMatchObject({ name: "bo", node: true });
  });
});

describe("the link rules read a qualified name as the dataset it names", () => {
  it("resolves `<sql name>.<dataset>` to its source, never to a node whose output spells the qualifier", () => {
    const tables = [hersForBo, hisForBo];
    const g = graphFor(
      [
        step({ id: "p", operation: "sql_step", parameters: { sql: "SELECT 1", name: "bo" } }),
        filterNode("bo.roads", { ordinal: 1 }),
      ],
      tables,
    );
    const m = memberByName(g, "bo.roads");
    expect(m?.kind).toBe("source");
    expect(m?.kind === "source" && m.tableId).toBe("t_bo_roads");
    // The filter passes its input's geometry through: his polygons.
    expect(expectedClass(nodeIn(g, "f"), g, OPS, tables)).toBe("polygon");
  });
});

describe("an output nothing has produced, beside the reader's own same-named dataset", () => {
  it("is still unproduced: the reader's own dataset is not the workflow's output", () => {
    const own = listed("t_bo_kept", "bo", "kept", 3);
    const g = graphFor([filterNode("roads")], [hersForBo, own]);
    expect(unproducedOutput("kept", g, [hersForBo, own])).toBe(true);
  });
});

describe("removing a node, as a reader whose own dataset shares its output's name", () => {
  const produced = (id: string) =>
    step({ id: "f", operation: "filter_rows", parameters: { input: "roads", name: "kept" }, reads: ["roads"], output: { id, name: "kept" }, conditions: ["current"] });
  it("says the output was deleted when only the reader's same-named dataset is listed", () => {
    const own = listed("t_bo_kept", "bo", "kept", 3);
    const g = graphFor([produced("t_ada_kept")], [hersForBo, own]);
    expect(removalPlan(nodeIn(g, "f"), g, [hersForBo, own]).state).toBe("deleted");
  });
  it("says the output stays when the listing holds it, whatever else shares the name", () => {
    const own = listed("t_bo_kept", "bo", "kept", 3);
    const hers = listed("t_ada_kept", "ada", "ada.kept", 9);
    const g = graphFor([produced("t_ada_kept")], [own, hers]);
    expect(removalPlan(nodeIn(g, "f"), g, [own, hers])).toMatchObject({ state: "exists", dataset: "kept" });
  });
});

describe("names written in the home", () => {
  it("writes a dataset the home owns plain and anyone else's qualified, for the home's owner and an Editor alike", () => {
    expect(names.writtenInHome(hersForBo, "ada")).toBe("roads");
    expect(names.writtenInHome(hisForBo, "ada")).toBe("bo.roads");
    const ownForAda = listed("t_ada_roads", "ada", "roads", 7);
    const hisForAda = listed("t_bo_roads", "bo", "bo.roads", 2);
    expect(names.writtenInHome(ownForAda, "ada")).toBe("roads");
    expect(names.writtenInHome(hisForAda, "ada")).toBe("bo.roads");
    // With no home known the reader's typed name stands, as before sharing.
    expect(names.writtenInHome(hisForAda, null)).toBe("bo.roads");
    expect(names.writtenInHome(ownForAda, null)).toBe("roads");
  });

  it("writes an import the reader just made qualified only on someone else's workflow", () => {
    expect(names.importedInHome("parks", "bo", "ada")).toBe("bo.parks");
    expect(names.importedInHome("parks", "ada", "ada")).toBe("parks");
    expect(names.importedInHome("parks", null, "ada")).toBe("parks");
    expect(names.importedInHome("parks", "bo", null)).toBe("parks");
  });

  it("takes a declared output's name only in the home or the reader's own space", () => {
    const cys = listed("t_cy_parks", "cy", "cy.parks", 1);
    const taken = (tables: TableListing[]) => names.outputNameTaken(tables, "ada")("parks");
    expect(taken([cys])).toBe(false);
    expect(taken([listed("t_bo_parks", "bo", "parks", 1)])).toBe(true);
    expect(taken([listed("t_ada_parks", "ada", "ada.parks", 1)])).toBe(true);
  });

  for (const [label, tables] of ORDERS) {
    it(`asks for a field's columns of the dataset the input names, as the reader types it (${label})`, () => {
      const g = graphFor([filterNode("roads")], tables);
      expect(names.readerAddressOf("roads", g, [...tables])).toBe("ada.roads");
      expect(names.readerAddressOf("bo.roads", g, [...tables])).toBe("roads");
      // Not listed: asked for in the home, never as the reader's bare name.
      expect(names.readerAddressOf("rivers", g, [...tables])).toBe("ada.rivers");
    });

    it(`marks only the dataset a source holds as on the canvas, and writes a drop for the home (${label})`, () => {
      const g = graphFor([filterNode("")], tables, { roads: { x: 0, y: 0 } });
      const rows = new Map(tables.map((t) => [t.id, names.paneRow(t, g)]));
      expect(rows.get("t_ada_roads")).toMatchObject({ typed: "ada.roads", written: "roads", here: true });
      expect(rows.get("t_bo_roads")).toMatchObject({ typed: "roads", written: "bo.roads", here: false, sourceId: null });
      expect(rows.get("t_ada_roads")?.sourceId).toBe(g.members.find((m) => m.kind === "source")?.id);
    });
  }
});
