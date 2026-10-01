import type { AccountScope } from "@/lib/auth/scope";
import { carryParameters } from "@/lib/query/handoff";
import { contextOf, isEvaluationContext, mapEvaluation, workflowEvaluation, type EvaluationContext } from "@/lib/query/context";
import { carriedSql, carryBetween, parseWrittenIn, sameContext, writtenInContext } from "@/lib/query/written-in";
import { findOperation } from "./catalog";
import { registeredOutputName } from "./output-names";
import { captureLayerSource } from "./recipe-api";

/**
 * Step definitions that arrive from somewhere else: parameters written in
 * the caller's console, another map or another workflow (a node pasted from
 * one workflow into another), and a layer's SQL captured from its map. Each
 * is carried into the destination's context through the handoff mechanism
 * (`query/handoff.ts`), so its references keep meaning the datasets they
 * meant: a home dataset of the source becomes qualified where the
 * destination's home is someone else's or an output there takes its name, a
 * departing workflow output becomes the dataset the caller's own run made.
 * The definition stored is the carried copy; nothing where it came from
 * changes.
 */

type Options = { signal?: AbortSignal; outputs?: readonly string[] };

function definitionOf(operationId: string) {
  const operation = findOperation(operationId);
  return { inputs: operation.inputs, takesSql: operation.parameters.some((parameter) => parameter.name === "sql") };
}

/** The name a definition declares for its output, as the registry stores it. */
export function declaredOutput(parameters: Record<string, unknown>): string | null {
  return typeof parameters.name === "string" && parameters.name.trim() !== "" ? registeredOutputName(parameters.name) : null;
}

/** Parameters written in one context, as another stores or runs them: the
 * same object when the two bind every name alike. */
export async function carriedParameters(
  operationId: string,
  parameters: Record<string, unknown>,
  from: EvaluationContext,
  to: EvaluationContext,
  options: Options = {},
): Promise<Record<string, unknown>> {
  if (sameContext(from, to)) return parameters;
  const definition = definitionOf(operationId);
  return carryBetween(from, to, (conn, source, destination) =>
    carryParameters(conn, definition, parameters, source, destination), options);
}

/**
 * Capture a layer for a step: any layer the caller reaches, its SQL refined
 * by its filters (never its aggregation), carried from the map's home into
 * the destination's context. A layer the caller does not reach answers as a
 * missing one.
 */
export async function captureLayerInto(scope: AccountScope, layerId: string, to: EvaluationContext, options: Options = {}): Promise<{
  sql: string;
  origin: Record<string, unknown>;
}> {
  const captured = captureLayerSource(scope, layerId);
  const from = mapEvaluation(scope, String(captured.origin.mapId));
  const sql = isEvaluationContext(from) ? await carriedSql(captured.sql, from, to, options) : captured.sql;
  return { sql, origin: captured.origin };
}

/**
 * A step definition as a workflow is to store it, from an add or an edit
 * request: the parameters carried from where `writtenIn` says they were
 * written, and a captured layer's SQL. The step's own declared output takes
 * its name in the destination, so a dataset of that name the definition
 * read stays external. `parameters` is only carried when the request gave
 * it; a step's own stored definition was written here.
 */
export async function arrivingDefinition(
  scope: AccountScope,
  recipeId: string,
  operationId: string,
  parameters: Record<string, unknown>,
  body: { writtenIn?: unknown; fromLayerId?: unknown; parameters?: unknown },
  signal?: AbortSignal,
): Promise<{ parameters: Record<string, unknown>; origin: Record<string, unknown> | undefined }> {
  const written = parseWrittenIn(body.writtenIn, ["console", "map", "workflow"]);
  const capturing = typeof body.fromLayerId === "string" && body.fromLayerId !== "";
  if (!written && !capturing) return { parameters, origin: undefined };
  const to = workflowEvaluation(scope, recipeId);
  const own = declaredOutput(parameters);
  const options = { signal, outputs: own ? [own] : [] };
  let carried = parameters;
  if (written && body.parameters !== undefined) {
    carried = await carriedParameters(operationId, parameters, writtenInContext(scope, written), to, options);
  }
  if (!capturing) return { parameters: carried, origin: undefined };
  const captured = await captureLayerInto(scope, body.fromLayerId as string, to, options);
  return { parameters: { ...carried, sql: captured.sql }, origin: captured.origin };
}

/** A standalone operation's parameters written elsewhere, as the caller's
 * own console runs them. */
export async function standaloneParameters(
  scope: AccountScope,
  operationId: string,
  parameters: Record<string, unknown>,
  writtenIn: unknown,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const written = parseWrittenIn(writtenIn, ["console", "map", "workflow"]);
  if (!written) return parameters;
  return carriedParameters(operationId, parameters, writtenInContext(scope, written), contextOf(scope), { signal });
}
