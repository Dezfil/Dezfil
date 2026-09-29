import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { Database } from "better-sqlite3";
import { open } from "./db";
import { createRecipe, addStep, type RecipeStep } from "./recipes";
import {
  replaceEdges,
  edgesForStep,
  edgesForInput,
  clearEdges,
} from "./lineage";

let dir: string;
let db: Database;
let step: RecipeStep;
let other: RecipeStep;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  db = open(path.join(dir, "metadata.sqlite"));
  const r = createRecipe(testAccountScope(db), "R", db);
  step = addStep(r.id, { operation: "sql_step", parameters: {} }, db);
  other = addStep(r.id, { operation: "sql_step", parameters: {} }, db);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

const edge = (id: string, name: string, artifact: string) => ({
  inputTableId: id,
  inputTableName: name,
  boundArtifact: artifact,
});

describe("recording what a run read", () => {
  it("keeps the artifact each input was bound at", () => {
    replaceEdges(
      step.id,
      "out-1",
      [edge("t1", "stations", "tables/a.parquet"), edge("t2", "boroughs", "tables/b.parquet")],
      db,
    );

    const edges = edgesForStep(step.id, db);
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => e.inputTableName)).toEqual(["boroughs", "stations"]);
    expect(edges.find((e) => e.inputTableId === "t1")!.boundArtifact).toBe(
      "tables/a.parquet",
    );
  });

  it("is queryable from the input side — the direction staleness travels", () => {
    replaceEdges(step.id, "out-1", [edge("t1", "stations", "tables/a.parquet")], db);
    replaceEdges(other.id, "out-2", [edge("t1", "stations", "tables/a.parquet")], db);

    const readers = edgesForInput("t1", db);
    expect(readers.map((e) => e.stepId).sort()).toEqual([step.id, other.id].sort());
    expect(edgesForInput("nobody-reads-this", db)).toEqual([]);
  });

  it("keeps the input's name alongside its id, so a broken row can explain itself", () => {
    replaceEdges(step.id, "out-1", [edge("t1", "stations", "tables/a.parquet")], db);
    // The name survives here even after the table it named is deleted, which
    // is the only way a "broken" row can say what it lost.
    expect(edgesForStep(step.id, db)[0].inputTableName).toBe("stations");
  });
});

describe("a re-run replaces the edge set rather than adding to it", () => {
  it("drops an input the step no longer reads", () => {
    replaceEdges(
      step.id,
      "out-1",
      [edge("t1", "stations", "tables/a.parquet"), edge("t2", "boroughs", "tables/b.parquet")],
      db,
    );

    // Re-run against a different input set.
    replaceEdges(step.id, "out-1", [edge("t3", "depots", "tables/c.parquet")], db);

    const edges = edgesForStep(step.id, db);
    expect(edges.map((e) => e.inputTableId)).toEqual(["t3"]);
    // The decisive half: the old input no longer lists this step as a reader,
    // so refreshing it can no longer make this step stale.
    expect(edgesForInput("t1", db)).toEqual([]);
  });

  it("updates the bound artifact when the same input is read again", () => {
    replaceEdges(step.id, "out-1", [edge("t1", "stations", "tables/a.parquet")], db);
    replaceEdges(step.id, "out-1", [edge("t1", "stations", "tables/NEW.parquet")], db);

    const edges = edgesForStep(step.id, db);
    expect(edges).toHaveLength(1);
    expect(edges[0].boundArtifact).toBe("tables/NEW.parquet");
  });

  it("touches only its own step's edges", () => {
    replaceEdges(step.id, "out-1", [edge("t1", "stations", "tables/a.parquet")], db);
    replaceEdges(other.id, "out-2", [edge("t1", "stations", "tables/a.parquet")], db);

    replaceEdges(step.id, "out-1", [], db);

    expect(edgesForStep(step.id, db)).toEqual([]);
    expect(edgesForStep(other.id, db)).toHaveLength(1);
  });

  it("records a step that reads nothing without complaint", () => {
    replaceEdges(step.id, "out-1", [], db);
    expect(edgesForStep(step.id, db)).toEqual([]);
  });
});

describe("detaching", () => {
  it("clears a step's edges so nothing propagates through it", () => {
    replaceEdges(step.id, "out-1", [edge("t1", "stations", "tables/a.parquet")], db);
    expect(clearEdges(step.id, db)).toBe(1);
    expect(edgesForStep(step.id, db)).toEqual([]);
  });

  it("goes with the step when its recipe is deleted", () => {
    replaceEdges(step.id, "out-1", [edge("t1", "stations", "tables/a.parquet")], db);
    db.prepare(`DELETE FROM recipes WHERE id = ?`).run(step.recipeId);
    expect(edgesForStep(step.id, db)).toEqual([]);
  });
});
