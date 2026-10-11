import { ApiError } from "@/lib/api/errors";
import type { AccountScope } from "@/lib/auth/scope";
import { filterRefs, listRefs, styleRefs, vizRefs, widgetRefs, type ColumnRef } from "@/lib/column-validation";
import { inspectLayerGeometry } from "@/lib/layer-geometry";
import { assertWritableRefs } from "@/lib/layer-write-refs";
import { compileOperation } from "@/lib/operations/compile";
import { dryRun } from "@/lib/operations/materialize";
import { stepReads } from "@/lib/operations/step-reads";
import { isBoundedOutcome } from "@/lib/query/bounded";
import type { TemplateHome } from "@/lib/query/context";
import { DatasetUnavailable } from "@/lib/query/engine-message";
import { isAggregated } from "@/lib/viz";
import type { AdmittedTemplate } from "./admission";
import { templateMapEvaluation, templateStepEvaluation } from "./home";
import { refuse } from "./refusals";
import { drawnFeatures, templateRenderCap } from "./render-cap";

/**
 * The second stage of a template's admission: its documents against its
 * own data, through the engine and the template's home, writing nothing.
 *
 * Each step compiles as a run would compile it, in the evaluation of a run
 * at its turn: its inputs and its SQL bind to the template's datasets and
 * the results of the steps before it, and to nothing else. Then each layer
 * of the map draws a geometry from its SQL, and every column its style,
 * look, filters, tooltip, pop-up and published fields name, and every
 * column its widgets and the timeline read, is in its result, by the layer
 * and map writes' own checks, and draws within the render cap's default
 * (`render-cap.ts`). The home holds the version's datasets and
 * bundled results and nothing of anyone's, so a reference to a person's
 * dataset, or another template's, binds nothing: that is the reference
 * refusal. Anything else the roads refuse is the invalid refusal, with the
 * road's own sentence.
 *
 * Runs after the first stage, and after the datasets were read through the
 * upload's reader, since it reads them.
 */

function outside(where: string, written: string): never {
  return refuse("template_reference_outside", `${where} names "${written}", which is not a dataset of the template or a result of an earlier step.`);
}

/** A road's refusal, worded for where it came from in the template. A
 * timeout, the memory budget or a departed caller is the evaluation's own
 * outcome and passes as it is. */
async function underRoad<T>(where: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof DatasetUnavailable) outside(where, error.written);
    if (error instanceof ApiError && !isBoundedOutcome(error)) refuse("template_invalid", `${where}: ${error.message}`);
    throw error;
  }
}

async function admitSteps(scope: AccountScope, admitted: AdmittedTemplate, home: TemplateHome, signal?: AbortSignal): Promise<void> {
  const steps = admitted.workflow?.steps ?? [];
  const datasets = new Set(admitted.datasets.map((d) => d.name.toLowerCase()));
  for (const [ordinal, step] of steps.entries()) {
    const where = `The workflow's step ${ordinal + 1}`;
    const evaluation = templateStepEvaluation(scope, home, ordinal);
    const earlier = new Set(steps.slice(0, ordinal).map((s) => s.output.toLowerCase()));
    const reads = await underRoad(where, () => stepReads(evaluation, { operation: step.operation, parameters: step.parameters, proposedParameters: null }));
    for (const read of reads) {
      if (!datasets.has(read) && !earlier.has(read)) outside(where, read);
    }
    const compiled = await underRoad(where, () => compileOperation(scope, step.operation, step.parameters, { evaluation }));
    if (compiled.prepare) refuse("template_invalid", `${where} needs work before it has a query, which a template's steps never do.`);
    if (compiled.sql) await underRoad(where, () => dryRun(evaluation, compiled.sql, signal, step.operation));
  }
}

async function admitLayers(scope: AccountScope, admitted: AdmittedTemplate, home: TemplateHome, signal?: AbortSignal): Promise<void> {
  const { map } = admitted;
  const evaluation = templateMapEvaluation(scope, home);
  for (const [i, layer] of map.layers.entries()) {
    const where = `The map's layer ${i + 1} ("${layer.name}")`;
    await underRoad(where, () => inspectLayerGeometry(evaluation, layer.sql, signal));
    const refs: ColumnRef[] = [
      ...styleRefs(layer.style),
      ...vizRefs(layer.viz),
      ...filterRefs(layer.filters),
      ...listRefs(layer.tooltip, "styling", "tooltip"),
      ...listRefs(layer.popup, "styling", "pop-up"),
      ...listRefs(layer.publishedFields, "filterable", "published fields"),
      ...map.widgets.filter((w) => w.layerId === layer.id).flatMap((w) => widgetRefs(w)),
      ...(map.timeline && map.timeline.layerId === layer.id
        ? [{ family: "filterable" as const, needs: "time" as const, name: map.timeline.field, channel: "timeline" }]
        : []),
    ];
    // An aggregated layer's label attribute is dropped by the write, never
    // stored, so it is not a reference, as the layer write reads it.
    const read = isAggregated(layer.viz) ? refs.filter((ref) => ref.channel !== "label") : refs;
    await underRoad(where, () => assertWritableRefs(evaluation, read, [], layer.sql, layer.viz, signal));
    const cap = templateRenderCap();
    const docked = map.timeline && map.timeline.layerId === layer.id ? map.timeline.field : null;
    const drawn = await underRoad(where, () => drawnFeatures(evaluation, layer, docked, cap, signal));
    if (drawn > cap) {
      refuse("template_invalid", `${where} draws ${drawn.toLocaleString()} features, over the render cap of ${cap.toLocaleString()}. ` +
        "A template's layer draws within the cap, its large data as an aggregation or a slice.");
    }
  }
}

/**
 * Admit a version's documents against its data, or refuse it with a coded
 * refusal naming the first fault. `home` is the version's home prepared
 * over the folder being admitted.
 */
export async function admitTemplateBindings(
  scope: AccountScope,
  admitted: AdmittedTemplate,
  home: TemplateHome,
  signal?: AbortSignal,
): Promise<void> {
  await admitSteps(scope, admitted, home, signal);
  await admitLayers(scope, admitted, home, signal);
}
