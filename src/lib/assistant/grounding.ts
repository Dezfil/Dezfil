import { ApiError } from "@/lib/api/errors";
import type { TableCatalogue } from "@/lib/table-catalogue";
import type { AssistantContext } from "./context";
import { pick, projectMember, projectStep, record } from "./grounding-projection";

export const GROUNDING_MAX_BYTES = 96 * 1024;
interface Collection { items: Record<string, unknown>[]; total: number; incomplete: boolean; read: string }
interface Grounding {
  context: AssistantContext | null;
  catalogue: Collection;
  map?: Record<string, unknown> & { layers: Collection };
  recipe?: Record<string, unknown> & { steps: Collection };
  run?: Record<string, unknown> & { members: Collection };
}
function invalid(): never { throw new ApiError("assistant_context_invalid", "The submitted page context is malformed or refers to an incompatible object.", 400); }
function unavailable(): never { throw new ApiError("assistant_context_unavailable", "The page context could not be read from this instance.", 422); }
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const order = (key: string, selected?: string | null) => (a: Record<string, unknown>, b: Record<string, unknown>) => {
  if (a[key] === selected && b[key] !== selected) return -1;
  if (b[key] === selected && a[key] !== selected) return 1;
  return String(a[key]) < String(b[key]) ? -1 : String(a[key]) > String(b[key]) ? 1 : 0;
};
const collection = (total: number, read: string): Collection => ({ items: [], total, incomplete: total > 0, read });

/** Current instance facts are read through the documented loopback API. Only
 * bounded, explicitly projected facts cross into provider input.
 */
export async function loadGrounding(context: AssistantContext | undefined, baseUrl: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<string> {
  async function read(path: string, contextual = false): Promise<Record<string, unknown>> {
    let response: Response;
    try { response = await fetchImpl(baseUrl + path, { signal }); }
    catch { unavailable(); }
    if (!response.ok) {
      if (contextual && response.status === 404) invalid();
      if (response.status === 422 && record(record(await response.json()).error).code === "catalogue_too_large") {
        throw new ApiError("catalogue_too_large", "A schema definition exceeds the catalogue page bound.", 422);
      }
      unavailable();
    }
    return record(await response.json());
  }
  async function catalogue(query = ""): Promise<TableCatalogue> {
    return await read("/api/catalogue/tables" + query) as unknown as TableCatalogue;
  }
  const candidates: { collection: Collection; minimal: Record<string, unknown>; full: Record<string, unknown> }[] = [];
  const ground: Grounding = { context: context ?? null, catalogue: collection(0, "/api/catalogue/tables") };
  function add(target: Collection, values: Record<string, unknown>[], limit: number, key: string, readPath: (value: Record<string, unknown>) => string) {
    for (const value of values.slice(0, limit)) {
      if (typeof value[key] !== "string") unavailable();
      const minimal = { [key]: value[key], incomplete: true, read: readPath(value) };
      target.items.push(minimal);
      candidates.push({ collection: target, minimal, full: value });
    }
  }
  let priorityNames: string[] = [];
  let project: string | undefined;
  // The page's SQL home and the names its own outputs take: how that page's
  // SQL names each dataset differs from the caller's console when the home
  // is someone else's.
  let home: string | undefined;
  const declared = new Set<string>();
  if (context?.page === "builder") {
    const mapPath = `/api/maps/${encodeURIComponent(context.mapId)}`;
    const map = await read(mapPath, true);
    if (map.id !== context.mapId || !Array.isArray(map.layers)) invalid();
    const layers = map.layers.map(record);
    if (context.selectedLayerId !== null && !layers.some((layer) => layer.id === context.selectedLayerId && layer.mapId === map.id)) invalid();
    if (layers.some((layer) => layer.mapId !== map.id)) invalid();
    ground.map = { ...pick(map, ["id", "name", "home"]), layers: collection(layers.length, mapPath) };
    home = typeof map.home === "string" ? map.home : undefined;
    add(ground.map.layers, layers.sort(order("id", context.selectedLayerId)).map((layer) => pick(layer, ["id", "mapId", "name", "sql", "style", "visible", "filters", "viz"])), 32, "id", (layer) => `/api/layers/${encodeURIComponent(String(layer.id))}`);
    const dependencies = await read(mapPath + "/dependencies");
    if (!Array.isArray(dependencies.datasets)) unavailable();
    priorityNames = dependencies.datasets.map((value) => String(record(value).qualifiedName)).sort().slice(0, 32);
    project = typeof map.projectId === "string" ? map.projectId : undefined;
  }
  if (context?.page === "workflow") {
    const recipePath = `/api/recipes/${encodeURIComponent(context.recipeId)}`;
    const recipe = record((await read(recipePath, true)).recipe);
    if (recipe.id !== context.recipeId || !Array.isArray(recipe.steps)) invalid();
    const steps = recipe.steps.map(record);
    if (context.selectedStepId !== null && !steps.some((step) => step.id === context.selectedStepId && step.recipeId === context.recipeId)) invalid();
    if (steps.some((step) => step.recipeId !== context.recipeId)) invalid();
    ground.recipe = { ...pick(recipe, ["id", "name", "home"]), steps: collection(steps.length, recipePath) };
    home = typeof recipe.home === "string" ? recipe.home : undefined;
    for (const step of steps) {
      for (const value of [record(step.parameters).name, record(step.proposedParameters).name, record(step.output).name]) {
        if (typeof value === "string" && value !== "") declared.add(value.toLowerCase());
      }
    }
    add(ground.recipe.steps, steps.sort(order("id", context.selectedStepId)).map(projectStep), 64, "id", (step) => recipePath + `/steps/${encodeURIComponent(String(step.id))}`);
    if (context.lastRunId !== null) {
      const runPath = recipePath + `/runs/${encodeURIComponent(context.lastRunId)}`;
      const run = record((await read(runPath, true)).run);
      if (run.id !== context.lastRunId || run.recipeId !== context.recipeId || !Array.isArray(run.members)) invalid();
      ground.run = { ...pick(run, ["id", "recipeId", "kind", "outcome", "cancelled", "startedAt", "finishedAt"]), members: collection(run.members.length, runPath) };
      add(ground.run.members, run.members.map(record).sort(order("stepId", context.selectedStepId)).map(projectMember), 64, "stepId", () => runPath);
    }
  }
  // A metadata-only first page gives count and names without inspecting columns.
  const initial = await catalogue("?columns=0");
  if (!Array.isArray(initial.tables) || !Number.isSafeInteger(initial.total)) unavailable();
  ground.catalogue = collection(initial.total, "/api/catalogue/tables");
  if (project && priorityNames.length < 32) {
    const owned = await catalogue(`?columns=0&project=${encodeURIComponent(project)}`);
    priorityNames.push(...owned.tables.map((table) => table.qualifiedName));
  }
  // Datasets are addressed by the name the caller would type, which tells
  // two same-named datasets of different owners apart.
  const names = [...new Set([...priorityNames, ...initial.tables.map((table) => table.qualifiedName)])].slice(0, 32);
  for (const name of names) {
    let oversized = false;
    let page: TableCatalogue;
    try { page = await catalogue(`?names=${encodeURIComponent(name)}`); }
    catch (error) {
      if (!(error instanceof ApiError) || error.code !== "catalogue_too_large") throw error;
      oversized = true;
      page = await catalogue(`?names=${encodeURIComponent(name)}&columns=0`);
    }
    const table = page.tables?.[0];
    if (!table || table.qualifiedName !== name) unavailable();
    // How the page's own SQL names it: plain when it is the home's dataset
    // and no output of the workflow takes the name, owner-qualified else.
    const inHome = home === undefined ? {} : {
      homeName: table.owner.sqlName === home && !declared.has(table.name.toLowerCase()) ? table.name : `${table.owner.sqlName}.${table.name}`,
    };
    const value = { ...pick(table, ["id", "name", "qualifiedName", "owner", "projectIds", "rowCount", "geometryColumn", "geometryType", "crsAssumed", "columnCount", "nextColumnOffset"]), ...inHome, columns: table.columns.map((column) => pick(column, ["name", "type"])), incomplete: table.nextColumnOffset !== null };
    const path = `/api/catalogue/tables?names=${encodeURIComponent(name)}`;
    const minimal = { id: table.id, name: table.name, qualifiedName: name, ...inHome, columnCount: table.columnCount, omittedColumns: table.columnCount, incomplete: true, read: path };
    ground.catalogue.items.push(minimal);
    candidates.push({ collection: ground.catalogue, minimal, full: oversized ? minimal : { ...value, read: path } });
  }
  for (const subject of [ground.map, ground.recipe]) {
    if (subject && bytes(ground) > GROUNDING_MAX_BYTES && subject.name !== undefined) {
      delete subject.name; subject.incomplete = true;
    }
  }
  // Reserve every retained identity before fitting any definition. Nothing
  // shortens SQL, identifiers or style: an oversized definition is omitted whole.
  if (bytes(ground) > GROUNDING_MAX_BYTES) throw new ApiError("assistant_context_too_large", "Page context and required identities exceed the grounding budget.", 413);
  for (const candidate of candidates) {
    const index = candidate.collection.items.indexOf(candidate.minimal);
    candidate.collection.items[index] = candidate.full;
    if (bytes(ground) > GROUNDING_MAX_BYTES - 4) candidate.collection.items[index] = candidate.minimal;
  }
  for (const target of [ground.catalogue, ground.map?.layers, ground.recipe?.steps, ground.run?.members]) {
    if (target) target.incomplete = target.items.length < target.total || target.items.some((item) => item.incomplete === true);
  }
  return JSON.stringify(ground);
}
