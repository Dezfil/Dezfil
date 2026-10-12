import type { Layer } from "@/lib/metadata/maps";
import type { FillPaint } from "@/lib/style/style";
import type { TemplateDetail } from "@/lib/templates/card";
import type { TemplateSource } from "@/lib/templates/format";
import { templateDocumentId } from "@/lib/templates/ids";
import type { OpenedDataset, TemplateContents } from "@/lib/templates/opened";
import { effectiveStyle } from "@/lib/viz";
import type { TableListing } from "../api";
import type { PageRead } from "../workflow-canvas/workflow-read";
import type { WorkflowListing, WorkflowStep } from "../workflow-model";

/**
 * What a template's own page reads and how it words it: the rows of How
 * it's made, a layer's style in words, and a workflow example's documents
 * in the shape the workflow canvas reads a workflow's. Every fact is the
 * template's (the read of one, the installed version); this module only
 * arranges and words it.
 */

/** Who a template's datasets name as their owner, as its map does: no
 * account. Its datasets read as the canvas's own, under their plain names. */
const NO_ACCOUNT = { name: "Template", sqlName: "template" };

/** One dataset of How it's made's Data section: the line the facts give,
 * its source with licence and credit, and what the install measured. */
export interface DataRow {
  dataset: string;
  made: string;
  source: TemplateSource | null;
  rowCount: number | null;
  geometryType: string | null;
  geometryColumn: string | null;
}

export function dataRows(template: Pick<TemplateDetail, "howMade" | "sources">, opened: Pick<TemplateContents, "datasets"> | null): DataRow[] {
  return template.howMade.datasets.map((line) => {
    const measured = opened?.datasets.find((d) => d.name === line.dataset) ?? null;
    return {
      dataset: line.dataset,
      made: line.made,
      source: template.sources.find((s) => s.name === line.source) ?? null,
      rowCount: measured?.rowCount ?? null,
      geometryType: measured?.geometryType ?? null,
      geometryColumn: measured?.geometryColumn ?? null,
    };
  });
}

const METHOD: Record<string, string> = {
  quantile: "quantile breaks",
  equal: "equal intervals",
  natural: "natural breaks",
  custom: "breaks set by hand",
};

function fillWords(fill: FillPaint): string {
  switch (fill.type) {
    case "constant":
      return "One colour";
    case "categorical":
      return `Coloured by ${fill.attribute}, ${fill.map.length} ${fill.map.length === 1 ? "category" : "categories"}`;
    case "quantile": {
      const classes = fill.colors.length;
      const method = METHOD[fill.method ?? "quantile"];
      return `Coloured by ${fill.attribute} in ${classes} ${classes === 1 ? "class" : "classes"}, ${method}`;
    }
    case "continuous":
      return `Coloured by ${fill.attribute} on a continuous ramp`;
  }
}

/** A layer's style in one line: what its colour follows, then what else
 * the data drives, its labels and an opacity below full. */
export function styleWords(layer: Pick<Layer, "style" | "viz">): string {
  const style = layer.viz ? effectiveStyle(layer.style, layer.viz) : layer.style;
  const parts = [fillWords(style.fill)];
  if (style.strokeBy && style.strokeBy.type !== "constant") parts.push(`outline by ${style.strokeBy.attribute}`);
  if (style.pointRadiusBy) parts.push(`size by ${style.pointRadiusBy.attribute}`);
  if (style.strokeWidthBy) parts.push(`line width by ${style.strokeWidthBy.attribute}`);
  if (style.heightBy) parts.push(`height by ${style.heightBy.attribute}`);
  if (style.label) parts.push(style.label.attribute ? `labelled by ${style.label.attribute}` : "labelled with each cell's value");
  if (style.opacity < 1) parts.push(`${Math.round(style.opacity * 100)}% opacity`);
  return parts.join(", ");
}

/** The step list's words: "1 · Nearest", by the operation catalog's name. */
export function stepTitle(index: number, operation: string, labelOf: ((operation: string) => string) | null): string {
  return `${index + 1} · ${labelOf ? labelOf(operation) : operation}`;
}

function listing(dataset: OpenedDataset, template: Pick<TemplateDetail, "id" | "version">, opened: TemplateContents): TableListing {
  return {
    id: dataset.id,
    name: dataset.name,
    sourceFilename: null,
    format: "geoparquet",
    file: "",
    geometryColumn: dataset.geometryColumn,
    geometryType: dataset.geometryType,
    crsAssumed: false,
    headerSuspect: false,
    rowCount: dataset.rowCount,
    createdAt: opened.createdAt,
    source: "template",
    sourceParams: { template: template.id, version: template.version },
    importedAt: null,
    owner: NO_ACCOUNT,
    qualifiedName: dataset.name,
    sizeBytes: null,
    projectIds: [],
  };
}

/**
 * A workflow example's documents as the canvas reads a workflow's: the
 * steps as they stand, each with the bundled result it came with as its
 * output, carrying the mark that it is the template's own (so the node
 * panel names the template's result, never a run), and no run at all; the
 * arrangement with its notes; the template's datasets and results as the
 * datasets the canvas lists. Null for a map template.
 */
export function templatePage(template: Pick<TemplateDetail, "id" | "version">, opened: TemplateContents): Omit<PageRead, "operations"> | null {
  const flow = opened.workflow;
  if (!flow) return null;
  const mark = { template: template.id, version: template.version };
  const steps: WorkflowStep[] = flow.steps.map((step, ordinal) => ({
    id: step.id,
    ordinal,
    operation: step.operation,
    parameters: step.parameters,
    proposedParameters: null,
    output: { id: step.output.id, name: step.output.name },
    condition: "current",
    conditions: ["current"],
    causes: [],
    missingInputs: [],
    inputs: [],
    reads: [...step.reads],
    latestAttempt: null,
    lastSuccessAt: null,
    templateResult: mark,
  }));
  const outputs = new Set(steps.map((step) => step.output!.name));
  const sources = new Set(steps.flatMap((step) => step.reads).filter((name) => !outputs.has(name)));
  const recipe: WorkflowListing = {
    id: templateDocumentId({ template: template.id, version: template.version, kind: "workflow" }),
    name: flow.name,
    origin: "workflow",
    projectId: null,
    owner: NO_ACCOUNT,
    editRevision: opened.revision,
    lastChangedAt: null,
    lastChangedBy: null,
    createdAt: opened.createdAt,
    updatedAt: opened.updatedAt,
    summary: { nodes: steps.length, sources: sources.size, liveOutputs: steps.length, status: "up_to_date", count: 0 },
    steps,
  };
  return {
    recipe,
    layout: { ...flow.layout, editRevision: opened.revision },
    tables: [...opened.datasets, ...flow.steps.map((step) => step.output)].map((d) => listing(d, template, opened)),
  };
}

const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What a copy brings, as the copy dialog says it: the map, a workflow
 * example's workflow, and every dataset (the template's own and, for a
 * workflow example, each step's bundled result). */
export function comesWith(template: Pick<TemplateDetail, "kind" | "howMade" | "steps">): string {
  const datasets = counted(template.howMade.datasets.length + (template.steps?.length ?? 0), "dataset", "datasets");
  return template.kind === "workflow" ? `1 map, 1 workflow and ${datasets}` : `1 map and ${datasets}`;
}
