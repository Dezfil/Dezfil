import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PROJECT_EXPORT_FORMAT_VERSION } from "@/lib/export/project-export";
import { PngShapeError, pngDimensions } from "@/lib/export/png-codec";
import type { LayoutDocument } from "@/lib/metadata/recipe-layouts";
import { findOperation } from "@/lib/operations/catalog";
import { normalizeLayout } from "@/lib/operations/layout-document";
import { registeredOutputName, typedOutputNameProblem } from "@/lib/operations/output-names";
import { recipeName, recipeOrigin } from "@/lib/operations/recipe-api";
import { forbiddenContent } from "./deny";
import {
  FACTS_FILE,
  MANIFEST_FILE,
  RESULTS_FOLDER,
  TEMPLATE_DOCUMENT_MAX_BYTES,
  TEMPLATE_FORMAT_VERSION,
  TEMPLATE_PICTURE_MAX_BYTES,
  TEMPLATE_STEPS_MAX,
  TEMPLATE_THEMES,
  factsProblem,
  type TemplateFacts,
  type TemplateTheme,
} from "./format";
import {
  admitMapDocument,
  invalidDocument as invalid,
  TEMPLATE_PART_ID as SAFE_ID,
  underRule,
  type AdmittedMap,
} from "./map-document";
import { refuse, TemplateRefusal } from "./refusals";
import { creditProblem, licenceProblem } from "./rules";

export type { AdmittedLayer, AdmittedMap } from "./map-document";

/**
 * The first stage of a template's admission: its documents, read from a
 * version folder with no engine and no store.
 *
 * The rules are the write roads' own, called as values: the map document's
 * rules (map-document-rules.ts) against the document's own layers, each
 * layer's fields under the layer write's rules (layer-document-rules.ts)
 * and its style under the style's, each step's operation from the
 * catalogue and its output name under the output-name rule, the layout
 * under the layout document's rule. A document a client could not write is
 * refused here. Beside them the reader keeps one rule of its own, the deny
 * list (deny.ts), the format's (its two versions, the closed facts and
 * manifest, every member named and present) and the rules on declared
 * metadata (rules.ts: a redistributable licence, the credit note).
 *
 * What a document means against data (a layer's SQL drawing geometry, a
 * step's inputs binding to the template's own datasets) is the second
 * stage's, which reads the datasets this stage has only counted.
 */

/** The manifest of a version: the export's, read under a closed shape. */
export interface TemplateManifest {
  formatVersion: number;
  project: { name: string; note: string | null };
  contents: {
    maps: { id: string; name: string; file: string }[];
    workflows: { id: string; name: string; file: string }[];
    datasets: { id: string; name: string; file: string; format: string }[];
  };
}

export interface AdmittedStep {
  id: string;
  operation: string;
  parameters: Record<string, unknown>;
  /** The registered name of the dataset the step makes. */
  output: string;
  /** Its bundled result, relative to the version folder. */
  result: string;
}

export interface AdmittedWorkflow {
  id: string;
  name: string;
  file: string;
  origin: ReturnType<typeof recipeOrigin>;
  steps: AdmittedStep[];
  layout: LayoutDocument;
}

export interface AdmittedTemplate {
  folder: string;
  facts: TemplateFacts;
  manifest: TemplateManifest;
  map: AdmittedMap;
  workflow: AdmittedWorkflow | null;
  datasets: { name: string; file: string }[];
  pictures: Record<TemplateTheme, string>;
  /** Every member, relative to the folder, with its size. */
  members: Map<string, number>;
}

export interface AdmitFolderOptions {
  /** Members a form of its own keeps beside the version's, never named by
   * its documents (the installed form's record). */
  extraMembers?: readonly string[];
}

const MAP_FILE = /^maps\/[a-z0-9-]{1,100}\.json$/;
const WORKFLOW_FILE = /^workflows\/[a-z0-9-]{1,100}\.json$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Every regular file under the folder, relative and slash-separated, with
 * its size. A link or anything else that is not a plain file or folder is
 * not a member a version can hold. */
async function listMembers(folder: string): Promise<Map<string, number>> {
  const members = new Map<string, number>();
  const walk = async (dir: string, prefix: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else if (entry.isFile()) {
        members.set(rel, (await lstat(full)).size);
      } else {
        refuse("template_malformed", `The member "${rel}" is not a plain file.`);
      }
    }
  };
  await walk(folder, "");
  return members;
}

async function readDocument(
  folder: string,
  members: Map<string, number>,
  member: string,
  namedBy: string,
): Promise<unknown> {
  const size = members.get(member);
  if (size === undefined) {
    refuse("template_members_mismatch", `${namedBy} names "${member}", which the template does not hold.`);
  }
  if (size > TEMPLATE_DOCUMENT_MAX_BYTES) {
    invalid(`The document "${member}" is larger than a template document may be.`);
  }
  const text = await readFile(path.join(folder, member), "utf8");
  try {
    return JSON.parse(text);
  } catch {
    return refuse("template_malformed", `The document "${member}" is not JSON.`);
  }
}

function denyIn(document: unknown, member: string): void {
  const problem = forbiddenContent(document, `The document "${member}"`);
  if (problem) refuse("template_forbidden", problem);
}

function closedKeys(value: Record<string, unknown>, keys: readonly string[], at: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) invalid(`${at} has a field the format does not name: "${key}".`);
  }
}

function manifestOf(value: unknown): TemplateManifest {
  if (!isObject(value)) invalid("The manifest must be a JSON object.");
  const m = value as Record<string, unknown>;
  closedKeys(m, ["formatVersion", "generator", "exportedAt", "exportedBy", "project", "contents"], "The manifest");
  const project = m.project;
  if (!isObject(project)) invalid("The manifest's project must be an object.");
  const p = project as Record<string, unknown>;
  closedKeys(p, ["name", "note"], "The manifest's project");
  if (typeof p.name !== "string" || p.name.trim() === "") invalid("The manifest's project needs a name.");
  if (p.note !== undefined && p.note !== null && typeof p.note !== "string") invalid("The manifest's project note must be text.");
  const contents = m.contents;
  if (!isObject(contents)) invalid("The manifest's contents must be an object.");
  const c = contents as Record<string, unknown>;
  closedKeys(c, ["maps", "workflows", "datasets"], "The manifest's contents");
  const entries = (kind: "maps" | "workflows" | "datasets", keys: readonly string[]) => {
    const list = c[kind];
    if (!Array.isArray(list)) invalid(`The manifest's ${kind} must be a list.`);
    return (list as unknown[]).map((entry, i) => {
      const at = `The manifest's ${kind}[${i}]`;
      if (!isObject(entry)) invalid(`${at} must be an object.`);
      const e = entry as Record<string, unknown>;
      closedKeys(e, keys, at);
      for (const key of ["id", "name", "file"]) {
        if (typeof e[key] !== "string" || (e[key] as string).trim() === "") invalid(`${at} needs a ${key}.`);
      }
      return e;
    });
  };
  const maps = entries("maps", ["id", "name", "file"]);
  const workflows = entries("workflows", ["id", "name", "file"]);
  const datasets = entries("datasets", ["id", "name", "qualifiedName", "owner", "file", "format"]);
  return {
    formatVersion: m.formatVersion as number,
    project: { name: p.name as string, note: (p.note as string | null | undefined) ?? null },
    contents: {
      maps: maps.map((e) => ({ id: e.id as string, name: e.name as string, file: e.file as string })),
      workflows: workflows.map((e) => ({ id: e.id as string, name: e.name as string, file: e.file as string })),
      datasets: datasets.map((e, i) => {
        const at = `The manifest's datasets[${i}]`;
        const name = e.name as string;
        if (registeredOutputName(name) !== name) {
          invalid(`${at} is named "${name}", which is not a dataset name as one is stored.`);
        }
        if (e.qualifiedName !== undefined && e.qualifiedName !== name) {
          invalid(`${at} is qualified by another account's name; a template's datasets are its own.`);
        }
        if (e.format !== "geoparquet") invalid(`${at} must be GeoParquet.`);
        if (e.file !== `datasets/${name}.parquet`) invalid(`${at} must be the file datasets/${name}.parquet.`);
        return { id: e.id as string, name, file: e.file as string, format: "geoparquet" };
      }),
    },
  };
}

function workflowOf(value: unknown, file: string, datasetNames: ReadonlySet<string>): AdmittedWorkflow {
  const at = `The workflow "${file}"`;
  if (!isObject(value)) invalid(`${at} must be a JSON object.`);
  const workflow = value as Record<string, unknown>;
  if (typeof workflow.id !== "string" || !SAFE_ID.test(workflow.id)) invalid(`${at} needs an id of letters, digits, hyphens and underscores.`);
  const name = underRule(at, () => recipeName(workflow));
  const origin = underRule(at, () => recipeOrigin(workflow));
  if (!Array.isArray(workflow.steps) || workflow.steps.length === 0) invalid(`${at} must list its steps.`);
  const rawSteps = workflow.steps as unknown[];
  if (rawSteps.length > TEMPLATE_STEPS_MAX) invalid(`${at} has more than ${TEMPLATE_STEPS_MAX} steps.`);
  const outputs = new Set<string>();
  const steps = rawSteps.map((raw, i): AdmittedStep => {
    const stepAt = `${at}, step ${i + 1}`;
    if (!isObject(raw)) invalid(`${stepAt} must be an object.`);
    const step = raw as Record<string, unknown>;
    if (step.ordinal !== undefined && step.ordinal !== i) invalid(`${stepAt} is out of its order.`);
    if (typeof step.id !== "string" || !SAFE_ID.test(step.id)) invalid(`${stepAt} needs an id of letters, digits, hyphens and underscores.`);
    if (typeof step.operation !== "string") invalid(`${stepAt} needs an operation.`);
    const operation = underRule(stepAt, () => findOperation(step.operation as string));
    if (operation.requires?.length) {
      invalid(`${stepAt}: ${operation.label} reaches an outside service, which a template's steps never do.`);
    }
    if (!isObject(step.parameters)) invalid(`${stepAt} needs its parameters as an object.`);
    // A carried provenance names a map and layer outside the template.
    if (step.origin !== undefined && step.origin !== null) invalid(`${stepAt} carries where it was authored from; a template's steps carry none.`);
    const parameters = { ...(step.parameters as Record<string, unknown>) };
    const shape = typedOutputNameProblem(parameters.name);
    if (shape) invalid(`${stepAt}: ${shape.message}`);
    const output = registeredOutputName(parameters.name as string);
    if (output !== parameters.name) invalid(`${stepAt} names its result "${parameters.name as string}", which is not a dataset name as one is stored ("${output}").`);
    if (datasetNames.has(output)) invalid(`${stepAt} names its result "${output}", which a dataset of the template carries.`);
    if (outputs.has(output)) invalid(`${stepAt} names its result "${output}", which another step declares.`);
    outputs.add(output);
    return {
      id: step.id as string,
      operation: operation.id,
      parameters,
      output,
      result: `${RESULTS_FOLDER}/${step.id as string}.parquet`,
    };
  });
  const ids = steps.map((s) => s.id);
  if (new Set(ids).size !== ids.length) invalid(`${at} names one step id twice.`);
  const layout = underRule(`${at}'s layout`, () => normalizeLayout(workflow.layout ?? {}, new Set(ids)));
  return {
    id: workflow.id as string,
    name,
    file,
    origin,
    steps,
    layout,
  };
}

/**
 * Admit a version folder's documents, or refuse it with a coded refusal
 * naming the first fault. Reads nothing but the folder, writes nothing.
 */
export async function admitTemplateFolder(
  folder: string,
  options: AdmitFolderOptions = {},
): Promise<AdmittedTemplate> {
  const members = await listMembers(folder);
  const manifestRaw = await readDocument(folder, members, MANIFEST_FILE, "A template");
  const factsRaw = await readDocument(folder, members, FACTS_FILE, "A template");

  // An unread version is refused before its shape is judged: a later
  // format may be valid in ways this server cannot see.
  const exportVersion = isObject(manifestRaw) ? manifestRaw.formatVersion : undefined;
  if (exportVersion !== PROJECT_EXPORT_FORMAT_VERSION) {
    refuse("template_format_unsupported", `The manifest is in export format ${String(exportVersion)}; this server reads format ${PROJECT_EXPORT_FORMAT_VERSION}.`);
  }
  const templateVersion = isObject(factsRaw) ? factsRaw.formatVersion : undefined;
  if (templateVersion !== TEMPLATE_FORMAT_VERSION) {
    refuse("template_format_unsupported", `The facts are in template format ${String(templateVersion)}; this server reads format ${TEMPLATE_FORMAT_VERSION}.`);
  }

  denyIn(manifestRaw, MANIFEST_FILE);
  denyIn(factsRaw, FACTS_FILE);
  const factsShape = factsProblem(factsRaw);
  if (factsShape) invalid(`The facts: ${factsShape}`);
  const facts = factsRaw as TemplateFacts;
  const manifest = manifestOf(manifestRaw);

  const { maps, workflows, datasets } = manifest.contents;
  const expected = facts.kind === "map" ? { maps: 1, workflows: 0 } : { maps: 1, workflows: 1 };
  if (maps.length !== expected.maps || workflows.length !== expected.workflows) {
    invalid(
      facts.kind === "map"
        ? "A map template holds exactly one map and no workflow."
        : "A workflow example holds exactly one workflow and its result map.",
    );
  }
  if (datasets.length === 0) invalid("A template holds at least one dataset.");
  const datasetNames = new Set<string>();
  for (const d of datasets) {
    if (datasetNames.has(d.name)) invalid(`The manifest names the dataset "${d.name}" twice.`);
    datasetNames.add(d.name);
  }
  for (const entry of maps) if (!MAP_FILE.test(entry.file)) invalid(`The manifest names the map file "${entry.file}" outside maps/.`);
  for (const entry of workflows) if (!WORKFLOW_FILE.test(entry.file)) invalid(`The manifest names the workflow file "${entry.file}" outside workflows/.`);

  const mapRaw = await readDocument(folder, members, maps[0].file, "The manifest");
  denyIn(mapRaw, maps[0].file);
  const map = admitMapDocument(mapRaw, maps[0].file);

  let workflow: AdmittedWorkflow | null = null;
  if (workflows.length === 1) {
    const workflowRaw = await readDocument(folder, members, workflows[0].file, "The manifest");
    denyIn(workflowRaw, workflows[0].file);
    workflow = workflowOf(workflowRaw, workflows[0].file, datasetNames);
  }

  // A line per dataset, each dataset once.
  const lines = facts.howMade.datasets.map((l) => l.dataset);
  for (const name of lines) {
    if (!datasetNames.has(name)) invalid(`howMade names the dataset "${name}", which the template does not hold.`);
  }
  for (const name of datasetNames) {
    if (lines.filter((l) => l === name).length !== 1) invalid(`howMade must give the dataset "${name}" exactly one line.`);
  }

  // Every member named, and nothing else.
  const named: [string, string][] = [
    [MANIFEST_FILE, "A template"],
    [FACTS_FILE, "A template"],
    ...maps.map((m): [string, string] => [m.file, "The manifest"]),
    ...workflows.map((w): [string, string] => [w.file, "The manifest"]),
    ...datasets.map((d): [string, string] => [d.file, "The manifest"]),
    ...(workflow?.steps ?? []).map((s): [string, string] => [s.result, `The step "${s.id}"`]),
    ...TEMPLATE_THEMES.map((t): [string, string] => [facts.pictures[t], "The facts"]),
  ];
  for (const [member, namedBy] of named) {
    if (!members.has(member)) {
      refuse("template_members_mismatch", `${namedBy} names "${member}", which the template does not hold.`);
    }
  }
  const allowed = new Set([...named.map(([m]) => m), ...(options.extraMembers ?? [])]);
  for (const member of members.keys()) {
    if (!allowed.has(member)) {
      refuse("template_members_mismatch", `The template holds "${member}", which nothing in it names.`);
    }
  }

  for (const theme of TEMPLATE_THEMES) {
    const file = facts.pictures[theme];
    if (members.get(file)! > TEMPLATE_PICTURE_MAX_BYTES) {
      refuse("template_picture_too_large", `The ${theme} picture is larger than ${TEMPLATE_PICTURE_MAX_BYTES / (1024 * 1024)} MB.`);
    }
    try {
      pngDimensions(await readFile(path.join(folder, file)));
    } catch (error) {
      if (error instanceof PngShapeError) invalid(`The ${theme} picture is not a PNG image.`);
      throw error;
    }
  }

  // The rules on declared metadata: what the data may be shared under,
  // and the credit the map carries for it.
  const licence = licenceProblem(facts);
  if (licence) refuse("template_licence_refused", licence);
  const credit = creditProblem(facts, map.widgets);
  if (credit) refuse("template_credit_missing", credit);

  return {
    folder,
    facts,
    manifest,
    map,
    workflow,
    datasets: datasets.map((d) => ({ name: d.name, file: d.file })),
    pictures: { light: facts.pictures.light, dark: facts.pictures.dark },
    members,
  };
}

export { TemplateRefusal };
