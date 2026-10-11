import type { DuckDBConnection } from "@duckdb/node-api";
import { ApiError } from "@/lib/api/errors";
import { requireReachable } from "@/lib/auth/reach";
import type { AccountScope } from "@/lib/auth/scope";
import type { Namespace } from "./bindings";
import { boundedEvaluation } from "./bounded";
import { contextOf, isEvaluationContext, mapEvaluation, workflowEvaluation, type EvaluationContext } from "./context";
import { bindingNamespace, namespaceFor } from "./namespace";
import { carrySql } from "./handoff";

/**
 * Where SQL or a named input was written: the context whose names it uses.
 *
 * The caller's own SQL console (their home), a map (its SQL home) or a
 * workflow (its home and its declared outputs as the caller runs them). An
 * operation that evaluates text evaluates it there; an operation that stores
 * text in another context carries it over (`handoff.ts`), so a reference keeps
 * meaning the dataset it meant where it was written.
 */
export type WrittenIn =
  | { kind: "console" }
  | { kind: "map"; id: string }
  | { kind: "workflow"; id: string };

export type WrittenInKind = WrittenIn["kind"];

function invalid(allowed: readonly WrittenInKind[]): ApiError {
  const forms = allowed.map((kind) => (kind === "console" ? '{"kind": "console"}' : `{"kind": "${kind}", "id": …}`));
  return new ApiError("invalid_request", `"writtenIn" must be ${forms.join(" or ")} when given.`, 400);
}

/** The request's `writtenIn`, refused when malformed or of a kind the
 * operation does not take. Absent means the operation's own context. */
export function parseWrittenIn(value: unknown, allowed: readonly WrittenInKind[]): WrittenIn | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw invalid(allowed);
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (typeof kind !== "string" || !allowed.includes(kind as WrittenInKind)) throw invalid(allowed);
  const keys = Object.keys(record).filter((key) => key !== "kind");
  if (kind === "console") {
    if (keys.length) throw invalid(allowed);
    return { kind: "console" };
  }
  if (keys.length !== 1 || typeof record.id !== "string" || record.id.trim() === "") throw invalid(allowed);
  return { kind: kind as "map" | "workflow", id: record.id };
}

/** The evaluation context the text was written in. A map or workflow the
 * caller does not reach answers as a missing one. */
export function writtenInContext(scope: AccountScope, written: WrittenIn): EvaluationContext {
  if (written.kind === "console") return contextOf(scope);
  if (written.kind === "map") {
    requireReachable(scope, "map", written.id);
    const context = mapEvaluation(scope, written.id);
    return isEvaluationContext(context) ? context : contextOf(scope);
  }
  requireReachable(scope, "workflow", written.id);
  return workflowEvaluation(scope, written.id);
}

/** Two contexts that bind every name alike: the same home and the same
 * workflow (or none) for the same authority, and the same template's
 * version (or none). */
export function sameContext(a: EvaluationContext, b: EvaluationContext): boolean {
  return a.authority === b.authority && a.home === b.home && a.workflow === b.workflow &&
    a.template?.template === b.template?.template && a.template?.version === b.template?.version;
}

/**
 * Run a carry from one context into another: the source context mounted on
 * an evaluation of its own (the guard and dynamic names are read there), the
 * destination's namespace beside it. `outputs` adds names the destination
 * declares that are not stored yet (a step being added).
 */
export function carryBetween<T>(
  from: EvaluationContext,
  to: EvaluationContext,
  carry: (conn: DuckDBConnection, from: Namespace, to: Namespace) => Promise<T>,
  options: { signal?: AbortSignal; outputs?: readonly string[] } = {},
): Promise<T> {
  const stored = namespaceFor(to);
  const outputs = new Map(stored.outputs);
  for (const name of options.outputs ?? []) if (!outputs.has(name.toLowerCase())) outputs.set(name.toLowerCase(), null);
  const destination: Namespace = { ...stored, outputs };
  return boundedEvaluation((conn) => carry(conn, bindingNamespace(conn, from), destination), { scope: from, signal: options.signal });
}

/** SQL written in one context, as it is to be stored in another: the very
 * same text when the two bind every name alike. */
export async function carriedSql(sql: string, from: EvaluationContext, to: EvaluationContext,
  options: { signal?: AbortSignal; outputs?: readonly string[] } = {}): Promise<string> {
  if (sameContext(from, to) && !options.outputs?.length) return sql;
  return carryBetween(from, to, (conn, source, destination) => carrySql(conn, sql, source, destination), options);
}
