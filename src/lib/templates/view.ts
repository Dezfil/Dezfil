import type { TemplateMount } from "@/lib/query/context";
import { templateDocumentId } from "./ids";
import type { OpenedDataset, TemplateContents } from "./opened";
import { residentTemplate } from "./resident";

/**
 * What an installed template version holds, from its folder as the map's
 * reads find it; null when no installed version answers. Reads only:
 * nothing is fetched, staged or written.
 */
export function templateContents(id: string, version: number): TemplateContents | null {
  const resident = residentTemplate(id, version);
  if (!resident) return null;
  const dataset = (mount: TemplateMount): OpenedDataset => ({
    id: mount.id,
    name: mount.name,
    rowCount: mount.rowCount,
    geometryColumn: mount.geometryColumn,
    geometryType: mount.geometryType,
  });
  const reads = new Map((resident.facts.steps ?? []).map((step) => [step.id, step.reads]));
  const flow = resident.workflow;
  let workflow: TemplateContents["workflow"] = null;
  if (flow) {
    const { steps, sources, notes } = flow.layout;
    const placed = Object.keys(steps).length + Object.keys(sources).length + notes.length > 0;
    workflow = {
      name: flow.name,
      // The bundled results are mounted in the steps' order.
      steps: flow.steps.map((step, i) => ({
        id: step.id,
        operation: step.operation,
        parameters: structuredClone(step.parameters),
        output: dataset(resident.home.outputs[i]),
        reads: [...(reads.get(step.id) ?? [])],
      })),
      layout: {
        steps: structuredClone(steps),
        sources: structuredClone(sources),
        notes: structuredClone(notes),
        // An arrangement exported before it was ever written still places
        // what it holds, as the copy's does.
        updatedAt: flow.layoutUpdatedAt ?? (placed ? resident.updatedAt : null),
      },
    };
  }
  return {
    revision: resident.record.archive.sha256.slice(0, 32),
    mapId: templateDocumentId({ template: id, version, kind: "map" }),
    createdAt: resident.createdAt,
    updatedAt: resident.updatedAt,
    datasets: resident.home.datasets.map(dataset),
    workflow,
  };
}
