import { describe, expect, it } from "vitest";
import type { TableListing } from "./api";
import type { WorkflowListing, WorkflowStep } from "./workflow-model";
import { foldTables, shownItems, type DataFolder } from "./data-folders";

// On the listing shapes the page reads: the recipes listing's step
// output carries the table's id, the tables listing carries the same
// id.

let n = 0;
function table(over: Partial<TableListing> = {}): TableListing {
  n += 1;
  return {
    id: `t${n}`,
    name: `table_${n}`,
    source: "upload",
    rowCount: 10,
    sizeBytes: 1000,
    createdAt: "2026-08-01T00:00:00.000Z",
    importedAt: null,
    geometryColumn: null,
    geometryType: null,
    crsAssumed: false,
    headerSuspect: false,
    sourceFilename: null,
    sourceParams: null,
    ...over,
  } as TableListing;
}

function step(output: { id: string; name: string | null } | null): WorkflowStep {
  n += 1;
  return {
    id: `s${n}`,
    ordinal: 0,
    operation: "buffer",
    parameters: {},
    proposedParameters: null,
    output,
    condition: output ? "current" : "never_run",
    conditions: output ? [] : ["never_run"],
    causes: [],
    missingInputs: [],
    inputs: [],
    reads: [],
    latestAttempt: null,
    lastSuccessAt: null,
  };
}

function workflow(over: Partial<WorkflowListing> & { steps: WorkflowStep[] }): WorkflowListing {
  n += 1;
  return {
    id: `w${n}`,
    name: `Workflow ${n}`,
    origin: "workflow",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    summary: { nodes: over.steps.length, sources: 1, liveOutputs: 0, status: "up_to_date", count: 0 },
    ...over,
  } as WorkflowListing;
}

const folders = (items: ReturnType<typeof foldTables>) => items.filter((i): i is DataFolder => i.kind === "folder");
const looseNames = (items: ReturnType<typeof foldTables>) => items.filter((i) => i.kind === "table").map((i) => (i.kind === "table" ? i.table.name : ""));

describe("foldTables (behaviours 1 and 2)", () => {
  it("folds a workflow's current outputs by table id; a never-run node and a deleted output add nothing", () => {
    const a = table({ name: "out_a", source: "operation" });
    const b = table({ name: "out_b", source: "operation" });
    const upload = table({ name: "upload" });
    const w = workflow({
      steps: [step({ id: a.id, name: a.name }), step(null), step({ id: "gone", name: "out_gone" }), step({ id: b.id, name: b.name })],
    });
    const items = foldTables([upload, a, b], [w]);
    expect(folders(items)).toHaveLength(1);
    expect(folders(items)[0].outputs.map((t) => t.name)).toEqual(["out_a", "out_b"]);
    expect(looseNames(items)).toEqual(["upload"]);
  });

  it("a workflow with no current output has no folder", () => {
    const w = workflow({ steps: [step(null), step({ id: "gone", name: "x" })] });
    const items = foldTables([table()], [w]);
    expect(folders(items)).toHaveLength(0);
    expect(items).toHaveLength(1);
  });

  it("membership is by id, never by name: a new table reusing an output's name stays loose", () => {
    const reused = table({ name: "out_a", source: "operation", id: "new-id" });
    const w = workflow({ steps: [step({ id: "old-id", name: "out_a" })] });
    const items = foldTables([reused], [w]);
    expect(folders(items)).toHaveLength(0);
    expect(looseNames(items)).toEqual(["out_a"]);
  });

  it("a builder-origin recipe's output stays loose", () => {
    const out = table({ name: "tool_out", source: "operation" });
    const w = workflow({ origin: "builder", steps: [step({ id: out.id, name: out.name })] });
    const items = foldTables([out], [w]);
    expect(folders(items)).toHaveLength(0);
    expect(looseNames(items)).toEqual(["tool_out"]);
  });

  it("with no workflows read, every table is loose", () => {
    const items = foldTables([table(), table()], null);
    expect(items.every((i) => i.kind === "table")).toBe(true);
  });

  it("a table claimed by two workflows goes to the first and is listed once", () => {
    const out = table({ source: "operation" });
    const first = workflow({ steps: [step({ id: out.id, name: out.name })] });
    const second = workflow({ steps: [step({ id: out.id, name: out.name })] });
    const items = foldTables([out], [first, second]);
    expect(folders(items).map((f) => f.id)).toEqual([first.id]);
    expect(items).toHaveLength(1);
  });

  it("sums rows and size, the size unavailable when any output's is, and takes the newest time", () => {
    const a = table({ rowCount: 3, sizeBytes: 100, importedAt: "2026-08-10T00:00:00.000Z" });
    const b = table({ rowCount: 4, sizeBytes: 200, createdAt: "2026-08-12T00:00:00.000Z" });
    const c = table({ rowCount: 5, sizeBytes: null });
    const whole = workflow({ steps: [step({ id: a.id, name: a.name }), step({ id: b.id, name: b.name })] });
    const holed = workflow({ steps: [step({ id: c.id, name: c.name }), step({ id: a.id, name: a.name })] });
    const [f1] = folders(foldTables([a, b], [whole]));
    expect(f1.rows).toBe(7);
    expect(f1.bytes).toBe(300);
    expect(f1.updatedAt).toBe("2026-08-12T00:00:00.000Z");
    const [f2] = folders(foldTables([a, c], [holed]));
    expect(f2.rows).toBe(8);
    expect(f2.bytes).toBeNull();
  });
});

describe("shownItems (behaviours 4 and 5)", () => {
  const upload = table({ name: "berlin", rowCount: 50, sizeBytes: 5000, importedAt: "2026-08-15T00:00:00.000Z" });
  const overture = table({ name: "places", source: "overture", rowCount: 1, sizeBytes: 10 });
  const loosePart = table({ name: "tool_out", source: "operation", rowCount: 2, sizeBytes: 20 });
  const a = table({ name: "hotspots", source: "operation", rowCount: 30, sizeBytes: 3000, createdAt: "2026-08-11T00:00:00.000Z" });
  const b = table({ name: "clusters", source: "operation", rowCount: 40, sizeBytes: 4000, createdAt: "2026-08-13T00:00:00.000Z" });
  const w = workflow({ name: "Alpha study", steps: [step({ id: a.id, name: a.name }), step({ id: b.id, name: b.name })] });
  const items = foldTables([upload, overture, loosePart, a, b], [w]);
  const names = (list: ReturnType<typeof shownItems>) => list.map((i) => (i.kind === "table" ? i.table.name : `[${i.name}]`));

  it("sorts folders among loose tables: by name, by newest output, by summed rows, by summed size", () => {
    expect(names(shownItems(items, { query: "", filter: "all", sort: "name" }))).toEqual(["[Alpha study]", "berlin", "places", "tool_out"]);
    expect(names(shownItems(items, { query: "", filter: "all", sort: "updated" }))).toEqual(["berlin", "[Alpha study]", "places", "tool_out"]);
    expect(names(shownItems(items, { query: "", filter: "all", sort: "rows" }))).toEqual(["[Alpha study]", "berlin", "tool_out", "places"]);
    expect(names(shownItems(items, { query: "", filter: "all", sort: "size" }))).toEqual(["[Alpha study]", "berlin", "tool_out", "places"]);
  });

  it("orders the outputs inside a folder by the same sort", () => {
    const [f] = shownItems(items, { query: "", filter: "all", sort: "name" }).filter((i): i is DataFolder => i.kind === "folder");
    expect(f.matching.map((t) => t.name)).toEqual(["clusters", "hotspots"]);
    const [g] = shownItems(items, { query: "", filter: "all", sort: "rows" }).filter((i): i is DataFolder => i.kind === "folder");
    expect(g.matching.map((t) => t.name)).toEqual(["clusters", "hotspots"]);
  });

  it("Results keeps folders and loose operation results; another source keeps its loose tables and no folder", () => {
    expect(names(shownItems(items, { query: "", filter: "operation", sort: "name" }))).toEqual(["[Alpha study]", "tool_out"]);
    expect(names(shownItems(items, { query: "", filter: "upload", sort: "name" }))).toEqual(["berlin"]);
    expect(names(shownItems(items, { query: "", filter: "overture", sort: "name" }))).toEqual(["places"]);
  });

  it("a workflow-name search shows the folder with every output; an output-name search with the matching one, the facts unchanged", () => {
    const byWorkflow = shownItems(items, { query: "alpha", filter: "all", sort: "name" });
    expect(names(byWorkflow)).toEqual(["[Alpha study]"]);
    const [f] = byWorkflow.filter((i): i is DataFolder => i.kind === "folder");
    expect(f.matching.map((t) => t.name)).toEqual(["clusters", "hotspots"]);
    const byOutput = shownItems(items, { query: "hotsp", filter: "all", sort: "name" });
    expect(names(byOutput)).toEqual(["[Alpha study]"]);
    const [g] = byOutput.filter((i): i is DataFolder => i.kind === "folder");
    expect(g.matching.map((t) => t.name)).toEqual(["hotspots"]);
    expect(g.outputs).toHaveLength(2);
    expect(g.rows).toBe(70);
    expect(names(shownItems(items, { query: "nothing here", filter: "all", sort: "name" }))).toEqual([]);
  });
});
