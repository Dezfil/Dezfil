import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { Database } from "better-sqlite3";
import { open } from "./db";
import {
  createRecipe,
  getRecipe,
  listRecipes,
  renameRecipe,
  deleteRecipe,
  addStep,
  getStep,
  listSteps,
  editStep,
  promoteProposal,
  discardProposal,
  recordOutput,
  stepOwnsOutput,
  removeStep,
  moveStep,
  touchRecipe,
} from "./recipes";

let dir: string;
let db: Database;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  db = open(path.join(dir, "metadata.sqlite"));
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

const step = (n: string) => ({ operation: "sql_step", parameters: { name: n } });

describe("recipes", () => {
  it("round-trips: created, listed, read back, renamed, deleted", () => {
    const r = createRecipe(testAccountScope(db), "Accidents by borough", db);
    expect(getRecipe(r.id, db)).toEqual(r);
    expect(listRecipes(db).map((x) => x.id)).toEqual([r.id]);

    expect(renameRecipe(r.id, "Renamed", db)).toBe(true);
    expect(getRecipe(r.id, db)!.name).toBe("Renamed");

    expect(deleteRecipe(r.id, db)).toBe(true);
    expect(getRecipe(r.id, db)).toBeNull();
  });

  it("carries which surface made it, fixed at creation, and lists by it", () => {
    const w = createRecipe(testAccountScope(db), "Cafés within reach of stations", db);
    const b = createRecipe(testAccountScope(db), "Analysis of stations", db, "builder");
    expect(getRecipe(w.id, db)?.origin).toBe("workflow");
    expect(getRecipe(b.id, db)?.origin).toBe("builder");
    expect(listRecipes(db, { origin: "workflow" }).map((r) => r.id)).toEqual([w.id]);
    expect(listRecipes(db, { origin: "builder" }).map((r) => r.id)).toEqual([b.id]);
    expect(listRecipes(db).map((r) => r.id).sort()).toEqual([w.id, b.id].sort());
    // A rename leaves the origin where it was: nothing changes it.
    renameRecipe(b.id, "Renamed", db);
    expect(getRecipe(b.id, db)?.origin).toBe("builder");
  });

  it("answers null and false for what does not exist", () => {
    expect(getRecipe("nope", db)).toBeNull();
    expect(renameRecipe("nope", "x", db)).toBe(false);
    expect(deleteRecipe("nope", db)).toBe(false);
  });
});

describe("steps", () => {
  it("append in order, and list in that order", () => {
    const r = createRecipe(testAccountScope(db), "R", db);
    const a = addStep(r.id, step("a"), db);
    const b = addStep(r.id, step("b"), db);
    const c = addStep(r.id, step("c"), db);
    expect([a.ordinal, b.ordinal, c.ordinal]).toEqual([0, 1, 2]);
    expect(listSteps(r.id, db).map((s) => s.id)).toEqual([a.id, b.id, c.id]);
  });

  it("deleting a recipe takes its steps with it", () => {
    const r = createRecipe(testAccountScope(db), "R", db);
    addStep(r.id, step("a"), db);
    deleteRecipe(r.id, db);
    expect(listSteps(r.id, db)).toEqual([]);
  });

  it("reorders densely, so 'earlier than' stays unambiguous", () => {
    const r = createRecipe(testAccountScope(db), "R", db);
    const a = addStep(r.id, step("a"), db);
    const b = addStep(r.id, step("b"), db);
    const c = addStep(r.id, step("c"), db);

    moveStep(c.id, 0, db);

    const after = listSteps(r.id, db);
    expect(after.map((s) => s.id)).toEqual([c.id, a.id, b.id]);
    expect(after.map((s) => s.ordinal)).toEqual([0, 1, 2]);
  });

  it("closes the gap when a step is removed", () => {
    const r = createRecipe(testAccountScope(db), "R", db);
    const a = addStep(r.id, step("a"), db);
    const b = addStep(r.id, step("b"), db);
    const c = addStep(r.id, step("c"), db);

    expect(removeStep(b.id, db)).toBe(true);

    const after = listSteps(r.id, db);
    expect(after.map((s) => s.id)).toEqual([a.id, c.id]);
    expect(after.map((s) => s.ordinal)).toEqual([0, 1]);
  });

  it("removing a step keeps the output table it produced — the row goes, the data does not", () => {
    const r = createRecipe(testAccountScope(db), "R", db);
    const a = addStep(r.id, step("a"), db);
    recordOutput(a.id, { id: "t1", name: "out_a" }, "2026-08-12T00:00:00Z", db);

    removeStep(a.id, db);

    // Nothing in this repository touches data_tables; the caller keeps the
    // table. What is gone is the step's own row.
    expect(getStep(a.id, db)).toBeNull();
  });
});

describe("editing a step that has already produced an output (G3)", () => {
  it("edits a never-run step in place", () => {
    const r = createRecipe(testAccountScope(db), "R", db);
    const s = addStep(r.id, step("a"), db);

    expect(editStep(s.id, { name: "changed" }, db)).toBe("active");

    const after = getStep(s.id, db)!;
    expect(after.parameters).toEqual({ name: "changed" });
    expect(after.proposedParameters).toBeNull();
  });

  it("holds an edit as a proposal once the step owns an output", () => {
    const r = createRecipe(testAccountScope(db), "R", db);
    const s = addStep(r.id, step("a"), db);
    recordOutput(s.id, { id: "t1", name: "out_a" }, "2026-08-12T00:00:00Z", db);

    expect(editStep(s.id, { name: "changed" }, db)).toBe("proposed");

    const after = getStep(s.id, db)!;
    // What the step still means is what its output was produced from.
    expect(after.parameters).toEqual({ name: "a" });
    expect(after.proposedParameters).toEqual({ name: "changed" });
  });

  it("promotes a proposal only when told to", () => {
    const r = createRecipe(testAccountScope(db), "R", db);
    const s = addStep(r.id, step("a"), db);
    recordOutput(s.id, { id: "t1", name: "out_a" }, "2026-08-12T00:00:00Z", db);
    editStep(s.id, { name: "changed" }, db);

    promoteProposal(s.id, db);

    const after = getStep(s.id, db)!;
    expect(after.parameters).toEqual({ name: "changed" });
    expect(after.proposedParameters).toBeNull();
  });

  it("discards a proposal without disturbing the active definition", () => {
    const r = createRecipe(testAccountScope(db), "R", db);
    const s = addStep(r.id, step("a"), db);
    recordOutput(s.id, { id: "t1", name: "out_a" }, "2026-08-12T00:00:00Z", db);
    editStep(s.id, { name: "changed" }, db);

    discardProposal(s.id, db);

    const after = getStep(s.id, db)!;
    expect(after.parameters).toEqual({ name: "a" });
    expect(after.proposedParameters).toBeNull();
  });
});

describe("ownership is a stored fact", () => {
  it("is true only for the exact table the step produced", () => {
    const r = createRecipe(testAccountScope(db), "R", db);
    const s = addStep(r.id, step("a"), db);
    recordOutput(s.id, { id: "t1", name: "out_a" }, "2026-08-12T00:00:00Z", db);

    expect(stepOwnsOutput(s.id, { id: "t1", name: "out_a" }, db)).toBe(true);
    // A different id on the same name is a different table — the case a
    // reclaimed name creates, and the one that must not be writable.
    expect(stepOwnsOutput(s.id, { id: "t2", name: "out_a" }, db)).toBe(false);
    // And the same id under a different name is not it either.
    expect(stepOwnsOutput(s.id, { id: "t1", name: "other" }, db)).toBe(false);
  });

  it("is false for a step that has produced nothing", () => {
    const r = createRecipe(testAccountScope(db), "R", db);
    const s = addStep(r.id, step("a"), db);
    expect(stepOwnsOutput(s.id, { id: "t1", name: "out_a" }, db)).toBe(false);
  });

  it("is false for a step that does not exist", () => {
    expect(stepOwnsOutput("nope", { id: "t1", name: "out_a" }, db)).toBe(false);
  });
});

describe("last edited", () => {
  const stampOf = (id: string) => getRecipe(id, db)!.updatedAt;

  it("advances strictly on every accepted edit, never on a run", () => {
    const r = createRecipe(testAccountScope(db), "Reach", db);
    let last = stampOf(r.id);
    const later = (label: string) => {
      const next = stampOf(r.id);
      expect(next > last, label).toBe(true);
      last = next;
    };
    const same = (label: string) => expect(stampOf(r.id), label).toBe(last);

    // The repository's add does not bump: the route does, once it has validated.
    const a = addStep(r.id, step("a"), db);
    same("add, at the repository");
    expect(touchRecipe(r.id, db)).not.toBeNull();
    later("an accepted add, marked by the route");
    // Two edits inside one millisecond still strictly advance.
    editStep(a.id, { name: "a", sql: "SELECT 1" }, db);
    later("edit");
    editStep(a.id, { name: "a", sql: "SELECT 2" }, db);
    later("a second edit right after");
    renameRecipe(r.id, "Reach 2", db);
    later("rename");
    const b = addStep(r.id, step("b"), db);
    touchRecipe(r.id, db);
    later("second add");
    moveStep(b.id, 0, db);
    later("reorder");
    // A run's bookkeeping is not an edit: recording an output, promoting a proposal.
    recordOutput(a.id, { id: "t1", name: "a" }, new Date().toISOString(), db);
    same("recording an output");
    editStep(a.id, { name: "a", sql: "SELECT 3" }, db);
    later("an edit on a step that has run (held as a proposal)");
    promoteProposal(a.id, db);
    same("promoting the proposal on a successful run");
    editStep(a.id, { name: "a", sql: "SELECT 4" }, db);
    later("another proposal");
    discardProposal(a.id, db);
    later("discarding it is an edit");
    removeStep(b.id, db);
    later("remove");
    expect(touchRecipe("nope", db)).toBeNull();
  });
});
