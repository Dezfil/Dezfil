import type { AccountScope } from "@/lib/auth/scope";
import { metadataDb } from "@/lib/metadata/db";
import { boundedEvaluation } from "@/lib/query/bounded";
import { mapEvaluation } from "@/lib/query/context";
import { collectInputs, inputsKey, type ArtifactInputs } from "@/lib/query/evaluation-inputs";
import { namedSql } from "@/lib/query/named-sql";
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
    return { target: pictureTarget(scope, mapId, sketchIds), inputs, resolved };
  }
  throw new Error("The map changed while resolving picture inputs.");
}
export function rememberBindings(mapId: string, inputs: ArtifactInputs): void {
  metadataDb().prepare("UPDATE map_pictures SET binding_inputs = ? WHERE map_id = ?").run(inputsKey(inputs), mapId);
}
export function bindingsChanged(mapId: string, inputs: ArtifactInputs): boolean {
  const row = metadataDb().prepare("SELECT binding_inputs FROM map_pictures WHERE map_id = ?").get(mapId) as { binding_inputs: string | null } | undefined;
  return !!row?.binding_inputs && row.binding_inputs !== inputsKey(inputs);
}
