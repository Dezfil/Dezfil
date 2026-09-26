import type { ProductResource } from "@/lib/api/operation-metadata";
import type { ToolDef } from "@/lib/tools/tools";
import type { ToolResult } from "@/lib/tools/execute";

export interface ActionEffects {
  readOnly: boolean;
  writes: { resource: ProductResource; ids: string[]; collection: boolean }[];
}
export interface ResolvedConfirmation { target: string; consequence: string }
export const noEffects: ActionEffects = { readOnly: true, writes: [] };
export function valuesAt(value: unknown, path: string): unknown[] {
  if (!path) return [value];
  const [head, ...tail] = path.split(".");
  if (head === "*") return Array.isArray(value) ? value.flatMap((item) => valuesAt(item, tail.join("."))) : [];
  if (value === null || typeof value !== "object") return [];
  return valuesAt((value as Record<string, unknown>)[head], tail.join("."));
}
export function actionEffects(tool: ToolDef, args: Record<string, unknown>, body?: unknown): ActionEffects {
  const declaration = tool.effects;
  if (declaration.readOnly || (declaration.planningArgument && args[declaration.planningArgument] === true)) return noEffects;
  return { readOnly: false, writes: declaration.writes.map((write) => {
    const resultPaths = write.result ? typeof write.result === "string" ? [write.result] : write.result : [];
    const ids = [...new Set([
      ...(write.argument ? valuesAt(args, write.argument) : []),
      ...resultPaths.flatMap((p) => valuesAt(body, p)),
    ].filter((v): v is string => typeof v === "string" && v.length > 0))];
    return { resource: write.resource, ids, collection: ids.length === 0 };
  }) };
}
/** The map a qualifying change belongs to and the turn's group.
 * Qualifying is declared by the operation's effects, `history`:
 * its route records steps under the change group. A write on maps names
 * its map in the arguments; a write on layers names it in the response,
 * or in the subject read a gate made before the change (a deletion
 * answers with no body). Anything else, undo, redo and a map's deletion
 * among them, is excluded and exposes neither, claiming no undo. */
export function historyAssociation(tool: ToolDef, args: Record<string, unknown>, body: unknown, group?: string, knownMapId?: string): { mapId: string; group: string } | undefined {
  if (!group || tool.effects.readOnly || !tool.effects.history) return undefined;
  const mapWrite = tool.effects.writes.find((w) => w.resource === "maps");
  const layerWrite = tool.effects.writes.find((w) => w.resource === "layers");
  let mapId: unknown = mapWrite?.argument ? args[mapWrite.argument] : undefined;
  if (typeof mapId !== "string" && layerWrite) {
    mapId = ["mapId", "layer.mapId"].flatMap((path) => valuesAt(body, path)).find((v) => typeof v === "string") ?? knownMapId;
  }
  return typeof mapId === "string" && mapId ? { mapId, group } : undefined;
}
/** The subject a gate read, when the subject read answered. */
export function subjectFacts(subject: unknown): { mapId?: string } | undefined {
  const mapId = valuesAt(subject, "mapId")[0];
  return typeof mapId === "string" ? { mapId } : undefined;
}
/** The outcome a result earns, read with the operation's own effects
 * Uncertainty is for a mutation whose result is unknown: a read-only
 * operation that answered 5xx changed nothing, so it is a refusal and
 * carries its own code and sentence to the pane. The effects are the
 * operation's declaration, never a list of names kept here. */
export function actionOutcome(result: ToolResult, effects: ActionEffects) {
  const outcome = result.ok ? result.status === 202 ? "accepted" as const : "succeeded" as const
    : result.status >= 500 && !effects.readOnly ? "uncertain" as const : "refused" as const;
  const jobId = outcome === "accepted" ? ["run.id", "job.id", "id"].flatMap((p) => valuesAt(result.body, p)).find((v): v is string => typeof v === "string") : undefined;
  return { outcome, ...(jobId ? { jobId } : {}) };
}
