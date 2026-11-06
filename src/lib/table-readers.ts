import type { Database } from "better-sqlite3";
import type { DuckDBConnection } from "@duckdb/node-api";
import { ApiError } from "@/lib/api/errors";
import { resourceAbsent } from "@/lib/auth/owned-resource";
import { canReach } from "@/lib/auth/reach";
import type { AccountScope } from "@/lib/auth/scope";
import { requireOwnDataset } from "@/lib/dataset-address";
import { accountSqlNames } from "@/lib/metadata/accounts";
import { metadataDb } from "@/lib/metadata/db";
import { findOperation } from "@/lib/operations/catalog";
import { declaredReads, type StepDefinition } from "@/lib/operations/step-reads";
import { boundedEvaluation } from "@/lib/query/bounded";
import { reachableDatasets, resolveReference, type Namespace, type ReachableDataset } from "@/lib/query/bindings";
import { readOnlySql } from "@/lib/query/guard";
import { declaredOutputs } from "@/lib/query/namespace";
import { qualifiedNameParts } from "@/lib/query/qualified-name";
import { collectReferences, serializeSql } from "@/lib/query/references";

/**
 * What reads a table: every saved map layer and workflow step whose current
 * definition binds it, asked before the table is deleted.
 *
 * The dependency reads answer the forward question per document; nothing
 * answered the reverse one, so this asks the forward question of every
 * document about one table. Every candidate is analyzed, never filtered by
 * the table's name in the text: a query can build a table's name from
 * pieces, and a reader found missing would be reported as no reader.
 *
 * A reference keeps every part it was written with, and binds in a
 * namespace that holds the target alone: the document's home for plain
 * names, the target's owner for a qualified name, and, for a workflow, the
 * outputs it declares as the target's owner would run it. Reach only decides
 * whether a name binds, never which dataset it means, so that namespace
 * gives the identity every permitted evaluation of the document would. A
 * declared output is runner-specific, and only the target's owner's run of
 * it can be the target. The engine's own catalogues are never datasets.
 *
 * Templates bind in their version, never in an account's space, so they
 * read no one's table; the builder's one-step records are not workflows.
 *
 * Strict: a definition that cannot be analyzed, or a scan that outlives its
 * budget, fails the whole read. A shorter list must never pass as complete.
 *
 * Disclosure is decided after the analysis, by a second read: the caller
 * must still own the table, and each reader's document is listed only when
 * the caller can open it now. The rest are counted, and nothing about them
 * leaves the server, in an answer or in a refusal.
 */

/** How long the whole scan may take before the answer is a refusal. */
export const READERS_BUDGET_MS = 20_000;

export type TableReader =
  | {
      kind: "layer";
      map: { id: string; name: string; published: boolean };
      layer: { id: string; name: string };
    }
  | {
      kind: "step";
      workflow: { id: string; name: string };
      step: { id: string; position: number; operation: string; label: string };
    };

export interface TableReaders {
  table: { id: string; name: string; rowCount: number };
  /** The readers in maps and workflows the caller can open: maps first,
   * then workflows, each by name, then layer or step order. */
  readers: TableReader[];
  /** How many more layers and steps read the table, in maps and workflows
   * the caller cannot open. */
  unlisted: number;
}

interface MapRow { id: string; name: string; home: string | null }
interface LayerRow { id: string; map_id: string; name: string; sql: string; ordinal: number }
interface RecipeRow { id: string; name: string; home: string | null }
interface StepRow { id: string; recipe_id: string; ordinal: number; operation: string; parameters: string; proposed_parameters: string | null }

/** One definition to analyze: where it binds and what it says. */
interface Candidate {
  document: { kind: "map" | "workflow"; id: string };
  /** The layer or the step it is. */
  id: string;
  namespace: Namespace;
  /** A query to parse, or the dataset references a verb declares. */
  definition: { sql: string } | { references: string[][] };
}

/** The question's world, read at once: the target, every candidate
 * definition and the namespace each binds in. */
function capture(scope: AccountScope, address: string, db: Database) {
  return db.transaction(() => {
    const reached = requireOwnDataset(scope, address);
    const target = reachableDatasets([reached.table.id], db)[0];
    if (!target) throw resourceAbsent();
    const maps = db.prepare("SELECT id, name, home_account_id AS home FROM maps").all() as MapRow[];
    const layers = db.prepare("SELECT id, map_id, name, sql, ordinal FROM layers ORDER BY map_id, ordinal").all() as LayerRow[];
    const recipes = db.prepare("SELECT id, name, home_account_id AS home FROM recipes WHERE origin = 'workflow'").all() as RecipeRow[];
    const steps = db.prepare(`SELECT s.id, s.recipe_id, s.ordinal, s.operation, s.parameters, s.proposed_parameters
      FROM recipe_steps s JOIN recipes r ON r.id = s.recipe_id WHERE r.origin = 'workflow'
      ORDER BY s.recipe_id, s.ordinal`).all() as StepRow[];
    const sqlNames = accountSqlNames([...maps.map((m) => m.home), ...recipes.map((r) => r.home)], db);
    const home = (id: string | null, document: Candidate["document"]) => {
      // Homes are stamped when a document is made; one without is never
      // guessed at, since a guess could name the wrong table.
      if (id === null) throw unresolved(document, scope, db);
      return { id, sqlName: sqlNames.get(id) ?? null };
    };

    const candidates: Candidate[] = [];
    const mapHome = new Map(maps.map((m) => [m.id, m]));
    for (const layer of layers) {
      const map = mapHome.get(layer.map_id);
      if (!map) continue;
      const document = { kind: "map" as const, id: map.id };
      candidates.push({
        document,
        id: layer.id,
        namespace: { home: home(map.home, document), datasets: [target], outputs: new Map() },
        definition: { sql: layer.sql },
      });
    }
    const recipeOf = new Map(recipes.map((r) => [r.id, r]));
    const outputsOf = new Map<string, Map<string, string | null>>();
    for (const step of steps) {
      const recipe = recipeOf.get(step.recipe_id)!;
      const document = { kind: "workflow" as const, id: recipe.id };
      let outputs = outputsOf.get(recipe.id);
      if (!outputs) outputsOf.set(recipe.id, outputs = declaredOutputs(recipe.id, target.ownerId, db));
      candidates.push({
        document,
        id: step.id,
        namespace: { home: home(recipe.home, document), datasets: [target], outputs },
        definition: stepDefinition(step, document, scope, db),
      });
    }
    return { target, candidates };
  })();
}

/** A step's current definition: its declared dataset parameters, or its
 * query. One that cannot be read fails the whole read. */
function stepDefinition(row: StepRow, document: Candidate["document"], scope: AccountScope, db: Database): Candidate["definition"] {
  try {
    const step: StepDefinition = {
      operation: row.operation,
      parameters: JSON.parse(row.parameters) as Record<string, unknown>,
      proposedParameters: row.proposed_parameters === null ? null : JSON.parse(row.proposed_parameters) as Record<string, unknown>,
    };
    const declared = declaredReads(step);
    if (declared !== null) return { references: declared.map((value) => qualifiedNameParts(value) ?? [value]) };
    const params = step.proposedParameters ?? step.parameters;
    return { sql: typeof params.sql === "string" ? params.sql : "" };
  } catch {
    throw unresolved(document, scope, db);
  }
}

/** Every table reference a query makes, each with the parts it was written
 * with. Strict: a statement the engine cannot parse is a failure. */
async function referencesOf(conn: DuckDBConnection, sql: string): Promise<string[][]> {
  if (sql.trim() === "") return [];
  const parsed = await serializeSql(conn, sql);
  if (parsed.error || !Array.isArray(parsed.statements)) throw new Error("unparsable");
  const admitted = await serializeSql(conn, await readOnlySql(conn, sql));
  if (admitted.error || !Array.isArray(admitted.statements)) throw new Error("unparsable");
  const collected = await collectReferences(conn, admitted.statements);
  return collected.references.map((reference) => reference.parts);
}

/** The refusal for a definition that could not be analyzed. It names the
 * document only when the caller can open it; otherwise it says nothing
 * about whose it is or what it holds. */
function unresolved(document: Candidate["document"], scope: AccountScope, db: Database): ApiError {
  const named = canReach(scope, document.kind, document.id, db)
    ? `the ${document.kind} "${nameOf(document, db)}"`
    : "a map or workflow";
  return new ApiError(
    "dependencies_unresolved",
    `A query in ${named} could not be analyzed, so what reads this table cannot be listed completely.`,
    422,
  );
}

function nameOf(document: Candidate["document"], db: Database): string {
  const table = document.kind === "map" ? "maps" : "recipes";
  const row = db.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(document.id) as { name: string } | undefined;
  return row?.name ?? "";
}

/** Which candidates bind the target. */
async function readerIds(
  scope: AccountScope,
  target: ReachableDataset,
  candidates: Candidate[],
  signal: AbortSignal | undefined,
  db: Database,
): Promise<Set<string>> {
  const outcome: { failed: Candidate["document"] | null } = { failed: null };
  const found = await boundedEvaluation(async (conn) => {
    const ids = new Set<string>();
    for (const candidate of candidates) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      let references: string[][];
      if ("references" in candidate.definition) references = candidate.definition.references;
      else {
        try {
          references = await referencesOf(conn, candidate.definition.sql);
        } catch {
          outcome.failed = candidate.document;
          return ids;
        }
      }
      for (const parts of references) {
        const resolution = resolveReference(candidate.namespace, parts);
        if (resolution.status === "bound" && resolution.dataset.id === target.id) {
          ids.add(candidate.id);
          break;
        }
      }
    }
    return ids;
  }, {
    scope,
    signal,
    budgetMs: READERS_BUDGET_MS,
    timeoutError: () => new ApiError(
      "dependencies_unresolved",
      "Checking what reads this table took too long, so it cannot be listed completely.",
      422,
    ),
  });
  if (outcome.failed) throw unresolved(outcome.failed, scope, db);
  return found;
}

/** The readers, as the caller may see them now. */
function disclose(scope: AccountScope, targetId: string, ids: Set<string>, db: Database): TableReaders {
  return db.transaction(() => {
    const reached = requireOwnDataset(scope, targetId);
    const readers: (TableReader & { order: [number, string, number] })[] = [];
    let unlisted = 0;
    if (ids.size > 0) {
      const list = JSON.stringify([...ids]);
      const layers = db.prepare(`SELECT l.id, l.name, l.ordinal, m.id AS map_id, m.name AS map_name,
          m.publish_token IS NOT NULL AS published
        FROM layers l JOIN maps m ON m.id = l.map_id WHERE l.id IN (SELECT value FROM json_each(?))`)
        .all(list) as { id: string; name: string; ordinal: number; map_id: string; map_name: string; published: number }[];
      for (const layer of layers) {
        if (!canReach(scope, "map", layer.map_id, db)) { unlisted++; continue; }
        readers.push({
          kind: "layer",
          map: { id: layer.map_id, name: layer.map_name, published: layer.published === 1 },
          layer: { id: layer.id, name: layer.name },
          order: [0, layer.map_name, layer.ordinal],
        });
      }
      const steps = db.prepare(`SELECT s.id, s.ordinal, s.operation, r.id AS recipe_id, r.name AS recipe_name
        FROM recipe_steps s JOIN recipes r ON r.id = s.recipe_id WHERE s.id IN (SELECT value FROM json_each(?))`)
        .all(list) as { id: string; ordinal: number; operation: string; recipe_id: string; recipe_name: string }[];
      for (const step of steps) {
        if (!canReach(scope, "workflow", step.recipe_id, db)) { unlisted++; continue; }
        readers.push({
          kind: "step",
          workflow: { id: step.recipe_id, name: step.recipe_name },
          step: { id: step.id, position: step.ordinal + 1, operation: step.operation, label: findOperation(step.operation).label },
          order: [1, step.recipe_name, step.ordinal],
        });
      }
    }
    readers.sort((a, b) => a.order[0] - b.order[0]
      || a.order[1].localeCompare(b.order[1])
      || documentId(a).localeCompare(documentId(b))
      || a.order[2] - b.order[2]);
    return {
      table: { id: reached.table.id, name: reached.table.name, rowCount: reached.table.rowCount },
      readers: readers.map(({ order: _order, ...reader }) => reader),
      unlisted,
    };
  })();
}

function documentId(reader: TableReader): string {
  return reader.kind === "layer" ? reader.map.id : reader.workflow.id;
}

/** What reads one of the caller's own tables, addressed as a delete
 * addresses it: by name or by identifier. */
export async function readTableReaders(
  scope: AccountScope,
  address: string,
  signal?: AbortSignal,
  db: Database = metadataDb(),
): Promise<TableReaders> {
  const { target, candidates } = capture(scope, address, db);
  const ids = await readerIds(scope, target, candidates, signal, db);
  return disclose(scope, target.id, ids, db);
}
