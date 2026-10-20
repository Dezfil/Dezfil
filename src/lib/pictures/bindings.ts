import { inputsReached } from "@/lib/artifact-access";
import { reachableDatasetIds } from "@/lib/auth/reach";
import type { AccountScope } from "@/lib/auth/scope";
import { metadataDb } from "@/lib/metadata/db";
import { boundedEvaluation } from "@/lib/query/bounded";
import { mapEvaluation } from "@/lib/query/context";
import { collectInputs, inputsKey, type ArtifactInputs } from "@/lib/query/evaluation-inputs";
import { namedSql } from "@/lib/query/named-sql";
import { inputsAreCurrent } from "./inputs";
import { getPictureState, moveDigestFormula } from "./state";
import { pictureTarget } from "./publication";
/** Scheduling dependencies only. Publication evidence comes exclusively from
 * evaluations and archives actually consumed by the render attempt. */
export async function pictureBindings(scope: AccountScope, mapId: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = pictureTarget(scope, mapId);
    let resolved = true;
    const { inputs } = await collectInputs(async () => {
      for (const layer of before.map.layers.filter(layer => layer.visible)) {
        try { await boundedEvaluation(conn => namedSql(conn, layer.sql), { scope: mapEvaluation(scope, mapId) }); }
        catch { resolved = false; }
      }
    });
    if (pictureTarget(scope, mapId).digest !== before.digest) continue;
    const sketchIds = inputs.datasets.filter(input => (metadataDb().prepare("SELECT source FROM data_tables WHERE id = ?").get(input.id) as { source: string } | undefined)?.source === "sketch").map(input => input.id);
    const target = pictureTarget(scope, mapId, sketchIds);
    moveDigestFormula(mapId, target);
    return { target, inputs, resolved };
  }
  throw new Error("The map changed while resolving picture inputs.");
}
interface StoredBindings { inputs: ArtifactInputs; resolved: boolean }
export function storedBindings(mapId: string): StoredBindings | null {
  const row = metadataDb().prepare("SELECT binding_inputs FROM map_pictures WHERE map_id = ?").get(mapId) as { binding_inputs: string | null } | undefined;
  if (!row?.binding_inputs) return null;
  const [catalogue, datasets, resolved = false] = JSON.parse(row.binding_inputs) as [boolean, [string, string][], boolean?];
  return { inputs: { catalogue, datasets: datasets.map(([id, file]) => ({ id, file })) }, resolved };
}
export function rememberBindings(mapId: string, inputs: ArtifactInputs, resolved = true): void {
  // The third entry distinguishes a successful empty binding from missing
  // data. Older rows have no entry and are resolved again at the next look.
  const value = JSON.stringify([...JSON.parse(inputsKey(inputs)), resolved]);
  metadataDb().prepare("UPDATE map_pictures SET binding_inputs = ? WHERE map_id = ? AND binding_inputs IS NOT ?").run(value, mapId, value);
}
export function bindingsChanged(mapId: string, inputs: ArtifactInputs, resolved = true): boolean {
  const previous = storedBindings(mapId);
  return !!previous && (inputsKey(previous.inputs) !== inputsKey(inputs) || previous.resolved !== resolved);
}
/** Reuse a successful binding only while its drawing and artifacts agree.
 * Catalogue reads need a fresh namespace; unresolved reads must try again.
 * Every request is computed through here or `pictureBindings`, so a row on
 * the digest's first formula is moved before anything compares it. */
export async function schedulingBindings(scope: AccountScope, mapId: string) {
  const stored = storedBindings(mapId);
  if (stored?.resolved && !stored.inputs.catalogue && getPictureState(mapId) && inputsAreCurrent(stored.inputs) && inputsReached(stored.inputs, reachableDatasetIds(scope))) {
    const sketchIds = stored.inputs.datasets.filter(input => (metadataDb().prepare("SELECT source FROM data_tables WHERE id = ?").get(input.id) as { source: string } | undefined)?.source === "sketch").map(input => input.id);
    const target = pictureTarget(scope, mapId, sketchIds);
    if (target.digest === moveDigestFormula(mapId, target)?.digest) return { target, ...stored };
  }
  return pictureBindings(scope, mapId);
}
/** Filter before compiling SQL. Unknown and unresolved maps may bind newly
 * arrived data; catalogue readers may draw a newly visible dataset too. */
export function bindingMayUse(mapId: string, datasetIds: ReadonlySet<string>): boolean {
  const stored = storedBindings(mapId);
  return !stored?.resolved || stored.inputs.catalogue || stored.inputs.datasets.some(input => datasetIds.has(input.id));
}
