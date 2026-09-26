import type { Database } from "better-sqlite3";
import { metadataDb } from "./db";

/**
 * The canvas layout document: where a workflow's nodes and sources sit and
 * the notes written around them, stored **beside** the recipe and never
 * inside it.
 *
 * The separation is the point. The recipe is what runs; a run has to mean
 * the same thing whether or not anyone has arranged it, so nothing here is
 * read by the engine, and nothing the engine does reads this. A note in
 * particular is a layout-only annotation: no ports, no edges, no state, no
 * output, no place in a run.
 *
 * Positions are keyed two ways because the two kinds of thing have two
 * kinds of identity: a node by its step id, a source by the table's name —
 * a source is derived from what steps read, so its name is all it has. A
 * source may be positioned that no step reads yet: that is the loose table
 * doc 02 allows to live "only in the layout document".
 */

export interface LayoutPosition {
  x: number;
  y: number;
}

export const NOTE_COLORS = ["yellow", "green", "blue", "pink", "purple", "grey"] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];

export interface LayoutNote {
  /** Chosen by the writer; unique within the document. */
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: NoteColor;
  /** Markdown, stored verbatim. The canvas reads the `label:` line at
   * the top; the API interprets nothing. */
  text: string;
}

export interface LayoutDocument {
  /** By step id. */
  steps: Record<string, LayoutPosition>;
  /** By table name. */
  sources: Record<string, LayoutPosition>;
  notes: LayoutNote[];
}

export interface StoredLayout {
  document: LayoutDocument;
  /** When the document was last written; null for one never written. */
  updatedAt: string | null;
}

export const emptyLayout = (): LayoutDocument => ({ steps: {}, sources: {}, notes: [] });

/** One fixed key order, sorted maps, so equal documents serialize equally
 * and "changed" is a comparison of meaning, not of the order a client
 * happened to send keys in. Notes keep their order: it is the writer's,
 * and may be a stacking order. */
export function canonicalLayout(document: LayoutDocument): string {
  const positions = (map: Record<string, LayoutPosition>) =>
    Object.fromEntries(
      Object.keys(map)
        .sort()
        .map((k) => [k, { x: map[k].x, y: map[k].y }]),
    );
  return JSON.stringify({
    steps: positions(document.steps),
    sources: positions(document.sources),
    notes: document.notes.map((n) => ({
      id: n.id,
      x: n.x,
      y: n.y,
      w: n.w,
      h: n.h,
      color: n.color,
      text: n.text,
    })),
  });
}

interface LayoutRow {
  document: string;
  updated_at: string;
}

/** The document as stored — a recipe without a row reads as the empty
 * document. Nothing is filtered here; whether a stored node still exists is
 * the operations layer's question. */
export function getLayout(recipeId: string, db: Database = metadataDb()): StoredLayout {
  const row = db
    .prepare(`SELECT document, updated_at FROM recipe_layouts WHERE recipe_id = ?`)
    .get(recipeId) as LayoutRow | undefined;
  if (!row) return { document: emptyLayout(), updatedAt: null };
  const parsed = JSON.parse(row.document) as Partial<LayoutDocument>;
  return {
    document: {
      steps: parsed.steps ?? {},
      sources: parsed.sources ?? {},
      notes: parsed.notes ?? [],
    },
    updatedAt: row.updated_at,
  };
}

/**
 * Write the document whole, unconditionally. Whether the write *changed*
 * anything is not this layer's question: the stored row may still carry a
 * node the recipe has since lost, and a recipe with no row holds the empty
 * document — both are the operations layer's to compare against what a
 * reader would actually see.
 */
export function putLayout(
  recipeId: string,
  document: LayoutDocument,
  db: Database = metadataDb(),
): { updatedAt: string } {
  const updatedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO recipe_layouts (recipe_id, document, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(recipe_id) DO UPDATE SET document = excluded.document, updated_at = excluded.updated_at`,
  ).run(recipeId, canonicalLayout(document), updatedAt);
  return { updatedAt };
}
