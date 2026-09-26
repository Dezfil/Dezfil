import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import type { AssistantPage } from "@/lib/api/operation-metadata";
import { buildTools, deriveTools, type ToolDef } from "./tools";

/**
 * Display and relevance parity. Every assistant-callable operation
 * declares the record's words and, explicitly or through its tag, the
 * pages whose default offer holds it. The expectations below are written
 * by hand, per operation and per page, never derived from the tags or
 * the effects; the derivation is compared against them. Two seeded
 * documents prove the check can fail: one with a declaration removed,
 * one with a wrong non-empty relevance.
 */

const tools = buildTools();
const byName = new Map(tools.map((t) => [t.name, t]));

/** The page's own operations: the builder's map and
 * layer work with the table reads and the query; /sql's query and table
 * reads; the canvas's workflow reads and run reads with the table reads
 * and the query. Admission is applied on top of these by the offer
 * derivation; a write listed for /sql here would still never be offered. */
const EXPECTED: Record<AssistantPage, string[]> = {
  builder: [
    "compute_fill", "compute_scale", "create_layer", "create_map", "delete_layer", "delete_map", "duplicate_layer", "duplicate_map",
    "export_layer_data", "export_map_image", "get_field_stats", "get_layer", "get_map", "get_map_dependencies", "get_publication_state",
    "get_table_features", "inspect_table", "inspect_table_geometry", "layer_extent", "list_layer_fields", "list_layers", "list_maps",
    "list_operations", "list_palettes", "list_tables", "look_at_map", "publish_map", "read_table_catalogue", "redo_change", "render_layer", "run_operation",
    "run_sql", "search_map", "undo_change", "unpublish_map", "update_layer", "update_map",
  ],
  sql: ["export_sql_result", "get_table_features", "inspect_table", "inspect_table_geometry", "list_tables", "read_table_catalogue", "run_sql"],
  workflow: [
    "cancel_operation_run", "get_operation_run", "get_recipe", "get_recipe_layout", "get_recipe_run", "get_recipe_step", "get_table_features",
    "get_workflow_dependencies", "inspect_table", "inspect_table_geometry", "list_operation_runs", "list_operations", "list_recipe_runs",
    "list_recipes", "list_tables", "read_table_catalogue", "run_operation", "run_sql",
    // The canvas admits none of these, so the offer never holds them; they are the page's by
    // relevance alone.
    "add_recipe_step", "cancel_recipe_run", "create_recipe", "delete_recipe", "discard_recipe_step_edit", "duplicate_recipe",
    "move_recipe_step", "remove_recipe_step", "run_recipe", "run_recipe_step", "set_recipe_layout", "update_recipe", "update_recipe_step",
  ],
};

/** The operations the expectations above must name, and the pages they
 * must not: relevance is compared both ways. */
function relevanceMismatches(set: ToolDef[]): string[] {
  const problems: string[] = [];
  for (const page of ["builder", "sql", "workflow"] as const) {
    const expected = new Set(EXPECTED[page]);
    for (const tool of set) {
      const declared = tool.relevance.includes(page);
      if (declared && !expected.has(tool.name)) problems.push(`${tool.name} declares ${page} relevance the expectation does not`);
      if (!declared && expected.has(tool.name)) problems.push(`${tool.name} lacks the ${page} relevance the expectation names`);
    }
  }
  return problems;
}

describe("display declarations", () => {
  it("every generated tool declares a verb, and names its subject exactly when it declares one", () => {
    const problems: string[] = [];
    for (const tool of tools) {
      const inputs = Object.keys(tool.inputSchema.properties);
      if (!tool.display.verb.trim()) problems.push(`${tool.name} has an empty verb`);
      if (tool.display.verb.includes("{subject}") !== (tool.display.subject !== undefined)) problems.push(`${tool.name}: the verb and the subject declaration disagree`);
      for (const [, key] of tool.display.verb.matchAll(/\{arg\.([A-Za-z0-9_]+)\}/g)) if (!inputs.includes(key)) problems.push(`${tool.name} refers to an argument it does not take: ${key}`);
      const argument = tool.display.subject?.argument;
      if (argument && !inputs.includes(argument)) problems.push(`${tool.name}'s subject argument ${argument} is not an input`);
    }
    expect(problems).toEqual([]);
  });

  it("read-only POSTs, nested paths, conditional operations and collection subjects carry the expected words", () => {
    // A read-only POST: the computation is the subject's, the layer is the subject.
    expect(byName.get("compute_fill")!.display).toEqual({ verb: "Computed a {arg.method} fill by {arg.attribute} on the layer {subject}", subject: { resource: "layers", argument: "id" } });
    expect(byName.get("run_sql")!.display).toEqual({ verb: "Ran a query" });
    // A nested path: the workflow is the subject, the step its detail.
    expect(byName.get("get_recipe_step")!.display).toEqual({ verb: "Read a step of the workflow {subject}", subject: { resource: "recipes", argument: "id" } });
    // The conditional operation: the workflow is the subject in both forms.
    expect(byName.get("run_recipe")!.display).toEqual({ verb: "Ran the workflow {subject}", planningVerb: "Planned the workflow {subject}", subject: { resource: "recipes", argument: "id", name: ["recipe.name", "name"] } });
    // A collection subject: the table named by its identity, read through the catalogue at the
    // gate.
    expect(byName.get("delete_table")!.display).toEqual({ verb: "Deleted the dataset {subject}", subject: { resource: "tables", argument: "name" } });
    // A created subject: identity from the response, name from the response or the arguments.
    expect(byName.get("create_map")!.display).toEqual({ verb: "Created the map {subject}", subject: { resource: "maps", result: "id", name: ["name"] } });
  });

  it("relevance matches the hand-written page expectations both ways", () => {
    expect(relevanceMismatches(tools)).toEqual([]);
    // Effects stay the only authority for admission: relevance never adds a page a tool-excluded
    // operation would need.
    for (const page of ["builder", "sql", "workflow"] as const) expect(EXPECTED[page].every((name) => byName.has(name)), page).toBe(true);
  });
});

/** A document with one operation's declaration altered, derived through the
 * same code the product uses. */
function seededDocument(alter: (op: Record<string, unknown>) => void, tool = "update_map") {
  const doc = structuredClone(buildOpenApiDocument()) as unknown as { paths: Record<string, Record<string, Record<string, unknown>>> };
  for (const methods of Object.values(doc.paths)) for (const op of Object.values(methods)) if (op["x-tool"] === tool) alter(op);
  return doc as unknown as ReturnType<typeof buildOpenApiDocument>;
}

describe("the check fails on a seeded declaration", () => {
  it("a missing display declaration fails the derivation, naming the tool", () => {
    const missing = seededDocument((op) => { delete op["x-display"]; });
    expect(() => deriveTools(missing)).toThrow(/Tool update_map \(PATCH \/api\/maps\/\{id\}\) has no x-display declaration/);
  });
  it("a wrong non-empty relevance fails the page comparison, naming the page", () => {
    const wrong = seededDocument((op) => { op["x-relevance"] = ["sql"]; });
    const problems = relevanceMismatches(deriveTools(wrong));
    expect(problems).toEqual([
      "update_map lacks the builder relevance the expectation names",
      "update_map declares sql relevance the expectation does not",
    ]);
  });
});

describe("the declarations behind findings 2 and 4", () => {
  it("exactly the operations whose routes record history steps under the change group declare it", () => {
    const declared = tools.filter((t) => t.effects.history).map((t) => t.name).sort();
    // update_map (PATCH /api/maps/{id}), create_layer (POST /api/maps/{id}/layers), update_layer
    // and delete_layer (PATCH, DELETE /api/layers/{id}), duplicate_layer (POST
    // /api/layers/{id}/duplicate): the routes that pass changeGroupOf(request) to a service that
    // calls recordStep.
    expect(declared).toEqual(["create_layer", "delete_layer", "duplicate_layer", "update_layer", "update_map"]);
    for (const name of declared) expect(byName.get(name)!.effects.readOnly).toBe(false);
  });
  it("every operation with a planning argument declares the words for a planning call", () => {
    const planning = tools.filter((t) => t.effects.planningArgument);
    expect(planning.map((t) => t.name).sort()).toEqual(["run_operation", "run_recipe"]);
    for (const tool of planning) expect(tool.display.planningVerb, `${tool.name} names its planning verb`).toEqual(expect.any(String));
    expect(byName.get("run_recipe")!.display.planningVerb).toBe("Planned the workflow {subject}");
    expect(byName.get("run_operation")!.display.planningVerb).toBe("Planned the operation {arg.operation}");
  });
});
