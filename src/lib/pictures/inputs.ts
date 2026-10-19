import type { AccountScope } from "@/lib/auth/scope";
import { pictureWorkScope } from "@/lib/auth/scope";
import { metadataDb } from "@/lib/metadata/db";
import { ApiError } from "@/lib/api/errors";
import { collectInputs, mergeInputs, NO_INPUTS, type ArtifactInputs } from "@/lib/query/evaluation-inputs";
interface AttemptInputs { inputs: ArtifactInputs; layers: string[]; invalid: boolean }
const empty = (): AttemptInputs => ({ inputs: NO_INPUTS, layers: [], invalid: false });
const incomplete = () => new ApiError("render_failed", "The picture's inputs changed or could not be recorded.", 502);

/** Fold evidence from the actual response, never from recompiled SQL. A
 * second artifact for an identity poisons the attempt rather than replacing
 * the first artifact in its evidence. */
export function recordPictureInputs(scope: AccountScope, layerId: string, inputs: ArtifactInputs | null): void {
  if (!scope.workKey) return;
  const db = metadataDb();
  db.transaction(() => {
    const row = db.prepare("SELECT work_inputs FROM map_pictures WHERE work_key = ?").get(scope.workKey) as { work_inputs: string | null } | undefined;
    if (!row) return;
    const record: AttemptInputs = row.work_inputs ? JSON.parse(row.work_inputs) : empty();
    if (!inputs) record.invalid = true;
    else {
      record.invalid ||= inputs.datasets.some(input => record.inputs.datasets.some(prior => prior.id === input.id && prior.file !== input.file));
      record.inputs = mergeInputs(record.inputs, inputs);
    }
    if (!record.layers.includes(layerId)) record.layers.push(layerId);
    db.prepare("UPDATE map_pictures SET work_inputs = ? WHERE work_key = ?").run(JSON.stringify(record), scope.workKey);
  })();
}
export async function collectPictureEvaluation<T>(scope: AccountScope, layerId: string, work: () => Promise<T>): Promise<T> {
  if (!scope.workKey) return work();
  const result = await collectInputs(work, inputs => recordPictureInputs(scope, layerId, inputs));
  recordPictureInputs(scope, layerId, result.inputs);
  return result.value;
}
export function inputsAreCurrent(inputs: ArtifactInputs): boolean {
  const db = metadataDb();
  return inputs.datasets.every(input => (db.prepare("SELECT file FROM data_tables WHERE id = ?").get(input.id) as { file: string } | undefined)?.file === input.file);
}
export function readAttemptInputs(credential: string, visibleLayers: readonly string[]): ArtifactInputs {
  const { scope } = pictureWorkScope(credential);
  const row = metadataDb().prepare("SELECT work_inputs FROM map_pictures WHERE work_key = ?").get(scope.workKey) as { work_inputs: string | null };
  const record: AttemptInputs = row.work_inputs ? JSON.parse(row.work_inputs) : empty();
  if (record.invalid || visibleLayers.some(id => !record.layers.includes(id)) || !inputsAreCurrent(record.inputs)) throw incomplete();
  return record.inputs;
}
