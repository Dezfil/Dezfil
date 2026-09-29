import type { DatasetScope } from "@/lib/query/access";
import { boundedEvaluation } from "@/lib/query/bounded";
import type { RecipeStep } from "@/lib/metadata/recipes";
import { findOperation } from "./catalog";
import { queryInputs } from "./inputs";

/**
 * What tables a step would read.
 *
 * Two questions need this answer and neither can wait for the step to run: the
 * backward-only rule, checked when an edit or a reorder is made, and a
 * cascade's ordering, which has to know what a member depends on *before* it
 * has ever produced anything.
 *
 * **It is the parse, never a text scan.** `table-deps.ts` matches table names
 * in SQL text and deliberately over-matches — a name inside a string literal
 * counts — which is right for the tile path it serves and wrong here, where an
 * over-match would refuse a legal edit or invent a dependency that serialises a
 * cascade for no reason.
 *
 * **A verb that declares its inputs is read from its parameters.** It names its
 * tables directly, so no engine round trip is needed, and the answer is
 * available even for a step whose inputs do not exist yet — which is exactly
 * the case a fresh recipe's cascade has to plan.
 */
export type StepDefinition = Pick<
  RecipeStep,
  "operation" | "parameters" | "proposedParameters"
>;

/** The definition a read is about: a pending edit over the active one
 * (G3). One rule, shared by the tolerant view and the strict
 * dependencies read, so the two can never disagree about WHICH
 * definition they describe. */
export function currentDefinition(
  step: StepDefinition,
): Record<string, unknown> {
  return step.proposedParameters ?? step.parameters;
}

/** A verb that declares its inputs names them in its parameters; null
 * says the definition is SQL and needs the parser. */
export function declaredReads(step: StepDefinition): string[] | null {
  const params = currentDefinition(step);
  const operation = findOperation(step.operation);
  if (operation.inputs.length === 0) return null;
  return operation.inputs
    .map((input) => params[input.name])
    .filter((v): v is string => typeof v === "string" && v !== "")
    .map((v) => v.toLowerCase());
}

export async function stepReads(scope: DatasetScope, step: StepDefinition): Promise<string[]> {
  const declared = declaredReads(step);
  if (declared !== null) return declared;

  const params = currentDefinition(step);
  const sql = typeof params.sql === "string" ? params.sql : "";
  if (!sql) return [];
  // The parse alone: a table named here need not exist yet, and asking the
  // registry would drop exactly the dependencies a not-yet-run producer
  // creates.
  return boundedEvaluation(async (conn) =>
    (await queryInputs(conn, sql, () => null)).tables, { scope },
  );
}

/** Every step's read set, which is what a whole-recipe check or plan needs. */
export async function readsByStep(
  scope: DatasetScope,
  steps: RecipeStep[],
): Promise<Map<string, string[]>> {
  const entries = await Promise.all(
    steps.map(async (s) => [s.id, await stepReads(scope, s)] as const),
  );
  return new Map(entries);
}
