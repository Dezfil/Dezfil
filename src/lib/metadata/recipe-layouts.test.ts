import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { Database } from "better-sqlite3";
import { open } from "./db";
import { createRecipe, deleteRecipe } from "./recipes";
import { canonicalLayout, getLayout, putLayout, type LayoutDocument } from "./recipe-layouts";

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

const doc: LayoutDocument = {
  steps: { s2: { x: 360, y: 40 }, s1: { x: 40, y: 60 } },
  sources: { stations: { x: 40, y: 330 } },
  notes: [
    { id: "n1", x: 20, y: 20, w: 420, h: 300, color: "yellow", text: "---\nlabel: intake\n---\n## Intake" },
    { id: "n2", x: 700, y: 20, w: 300, h: 200, color: "blue", text: "" },
  ],
};

describe("the layout store", () => {
  it("reads the empty document, with no write time, for a recipe never arranged", () => {
    const r = createRecipe("Unarranged", db);
    expect(getLayout(r.id, db)).toEqual({
      document: { steps: {}, sources: {}, notes: [] },
      updatedAt: null,
    });
  });

  it("round-trips a document whole and stamps the write", () => {
    const r = createRecipe("Arranged", db);
    const written = putLayout(r.id, doc, db);
    const read = getLayout(r.id, db);
    expect(read.updatedAt).toBe(written.updatedAt);
    expect(read.document).toEqual(doc);
    // A second write replaces the row and restamps it; whether anything
    // changed is the operations layer's question, not the store's.
    const moved = putLayout(r.id, { ...doc, steps: { ...doc.steps, s1: { x: 41, y: 60 } } }, db);
    expect(getLayout(r.id, db)).toEqual({
      document: { ...doc, steps: { ...doc.steps, s1: { x: 41, y: 60 } } },
      updatedAt: moved.updatedAt,
    });
  });

  it("canonical form is the same whatever order the keys came in, and note order counts", () => {
    const reordered: LayoutDocument = {
      notes: doc.notes.map((n) => ({ ...n })),
      sources: { ...doc.sources },
      steps: { s1: { y: 60, x: 40 }, s2: { y: 40, x: 360 } },
    };
    expect(canonicalLayout(reordered)).toBe(canonicalLayout(doc));
    expect(canonicalLayout({ ...doc, notes: [doc.notes[1], doc.notes[0]] })).not.toBe(canonicalLayout(doc));
    expect(canonicalLayout({ ...doc, steps: { ...doc.steps, s1: { x: 41, y: 60 } } })).not.toBe(canonicalLayout(doc));
  });

  it("canonical form sorts the maps and fixes each note's key order", () => {
    const a = canonicalLayout(doc);
    const b = canonicalLayout({
      notes: doc.notes.map((n) => ({ text: n.text, color: n.color, h: n.h, w: n.w, y: n.y, x: n.x, id: n.id })),
      sources: doc.sources,
      steps: { s1: doc.steps.s1, s2: doc.steps.s2 },
    });
    expect(a).toBe(b);
  });

  it("goes with its recipe", () => {
    const r = createRecipe("Doomed", db);
    putLayout(r.id, doc, db);
    expect(deleteRecipe(r.id, db)).toBe(true);
    expect(db.prepare(`SELECT count(*) AS n FROM recipe_layouts`).get()).toEqual({ n: 0 });
    // And cannot be written for a recipe that does not exist: the row
    // references its recipe.
    expect(() => putLayout("nope", doc, db)).toThrow();
  });
});
