"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { TableListing } from "../../api";
import type { RecipeSummary } from "./recipe-model";
import { stepsByOutput } from "./derived-tables";

/**
 * What a layer card knows about the output it draws (narrowing recipe-wide
 * sentence to the owning output's own state).
 *
 * **A module store rather than a prop or a context**, for one reason: the card
 * that needs the sentence lives in the inspector and the data that produces it
 * is loaded by the drawer, and they are siblings. Threading it through would
 * grow `MapBuilder.tsx`, which the decomposition rule forbids at exactly the
 * feature that touches it; a context would have to wrap both. One publisher,
 * many readers, no fetch per card.
 *
 * The store holds a **snapshot**, so a card renders whatever the drawer last
 * read. Before the drawer has read anything a card says nothing, which is the
 * honest state rather than a guess.
 */

interface Snapshot {
  recipes: RecipeSummary[];
  tables: TableListing[];
  /** Id → served label, so the strip's copy speaks the catalog's own words
   * — never the snake_case id. */
  labels: Record<string, string>;
}

let snapshot: Snapshot = { recipes: [], tables: [], labels: {} };
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const read = () => snapshot;
/** The server has no snapshot, and a card that rendered one would hydrate
 * against a different answer. */
const readServer = (): Snapshot => EMPTY;
const EMPTY: Snapshot = { recipes: [], tables: [], labels: {} };

/** Publish what the drawer has read. Called from the drawer's own composition,
 * which is the one place both halves are already in hand. */
export function publishRecipeNotes(next: Snapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

/** Keep the store in step with a live load. */
export function useRecipeNotePublisher(
  recipes: RecipeSummary[] | null,
  tables: TableListing[] | null,
  labels?: Record<string, string>,
): void {
  useEffect(() => {
    publishRecipeNotes({
      recipes: recipes ?? [],
      tables: tables ?? [],
      labels: labels ?? {},
    });
  }, [recipes, tables, labels]);
}

/**
 * The host's own settle, reachable from a card: the strip's Re-run
 * finishes outside the drawer, and what must reload afterwards —
 * recipes, tables, the map — is exactly what the host's settle already
 * reloads. One registrar, the host; one caller, the strip.
 */
let reloadFn: (() => void) | null = null;
export function registerNotesReload(fn: (() => void) | null): void {
  reloadFn = fn;
}
export function reloadRecipeNotes(): void {
  reloadFn?.();
}

/** What the strip and the table door project: the owning step's
 * own condition — never a recipe roll-up. */
export interface OutputStatus {
  recipeId: string;
  stepId: string;
  operation: string;
  /** The served label, falling back to the humanized id while the catalog
   * loads. */
  operationLabel: string;
  output: { id: string; name: string };
  /** The primary condition, the API's own word. */
  condition: string;
  /** Every active stale cause, each naming its source. */
  causes: { reason: string; tableId: string; tableName: string }[];
  /** The latest attempt's failure, when it failed. */
  failed: { code: string; message: string } | null;
  /**
   * The observed-state fingerprint Ignore binds to (D2): condition, every
   * cause, each input's current generation (importedAt moves per refresh
   * even where the artifact path does not), and the latest attempt — so a
   * second refresh re-arms the strip although the public condition still
   * reads "stale, source changed" for the same named source.
   */
  fingerprint: string;
}

/**
 * The status for a layer, or null when no live step owns what it draws.
 *
 * A layer names its table in its SQL, and the match is the same over-matching
 * whole-word one the door's pre-fill uses: a wrong match here costs a strip
 * on a card the user can see, rather than a wrong run.
 */
export function useOutputStatus(layerSql: string): OutputStatus | null {
  const current = useSyncExternalStore(subscribe, read, readServer);
  const compute = useCallback(() => {
    const byOutput = stepsByOutput(current.recipes);
    const text = layerSql.toLowerCase();
    // **Unique ownership, or nothing**: the SQL match
    // over-matches by design — a name inside a string, a query reading two
    // outputs — and a wrong *sentence* was the acceptable cost. A wrong
    // **Re-run** is not: the strip mutates the dataset it names, so the
    // mutating controls demand exactly one owned output in the layer's
    // SQL, the same one-or-nothing rule Select applies to its picks.
    const matches = current.tables.filter((table) => {
      if (!byOutput.has(table.id)) return false;
      return new RegExp(
        `\\b${table.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
      ).test(text);
    });
    if (matches.length !== 1) return null;
    {
      const table = matches[0];
      const ref = byOutput.get(table.id);
      if (!ref) return null;
      const recipe = current.recipes.find((r) => r.id === ref.recipeId);
      const step = recipe?.steps.find((x) => x.id === ref.stepId);
      if (!recipe || !step) return null;
      const attempt = step.latestAttempt as
        | { state?: string; error?: { code: string; message: string }; id?: string }
        | null;
      const causes = (step.causes ?? []) as OutputStatus["causes"];
      const generations = (step.inputs ?? []).map((input: { id: string }) => {
        const held = current.tables.find((t) => t.id === input.id);
        // The artifact path is the generation's identity — a swap names a
        // new file; the timestamp rides along as a belt.
        return held ? `${held.id}:${held.file}:${held.importedAt ?? held.createdAt}` : input.id;
      });
      return {
        recipeId: recipe.id,
        stepId: step.id,
        operation: step.operation,
        operationLabel:
          current.labels[step.operation] ?? step.operation.replace(/_/g, " "),
        output: { id: table.id, name: table.name },
        condition: step.condition,
        causes,
        failed:
          attempt?.state === "failed" && attempt.error ? attempt.error : null,
        fingerprint: JSON.stringify([
          step.condition,
          causes.map((c) => `${c.reason}:${c.tableId}`),
          generations,
          attempt?.state === "failed" ? attempt.id : null,
        ]),
      };
    }
  }, [current, layerSql]);
  return compute();
}
