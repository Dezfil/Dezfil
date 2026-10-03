import { readApiError, readOperations, readTables } from "../api";
import { serverUnreachable } from "../failure-copy";
import { STALE_MESSAGE } from "../document-sequence";
import type { WorkflowListing } from "../workflow-model";
import type { LayoutRead } from "./placement";

export async function fetchWorkflow(id: string): Promise<WorkflowListing> {
  let response: Response;
  try {
    response = await fetch(`/api/recipes/${id}`, { cache: "no-store" });
  } catch {
    throw new Error(serverUnreachable("load the workflow"));
  }
  if (!response.ok) throw new Error(await readApiError(response));
  return ((await response.json()) as { recipe: WorkflowListing }).recipe;
}

export async function fetchLayout(id: string): Promise<LayoutRead> {
  let response: Response;
  try {
    response = await fetch(`/api/recipes/${id}/layout`, { cache: "no-store" });
  } catch {
    throw new Error(serverUnreachable("load the workflow's layout"));
  }
  if (!response.ok) throw new Error(await readApiError(response));
  return ((await response.json()) as { layout: LayoutRead }).layout;
}

export interface PageRead {
  recipe: WorkflowListing;
  layout: LayoutRead;
  tables: Awaited<ReturnType<typeof readTables>>;
  operations: Awaited<ReturnType<typeof readOperations>>;
}

export async function readWorkflowPage(id: string): Promise<PageRead> {
  const [recipe, layout, tables, operations] = await Promise.all([fetchWorkflow(id), fetchLayout(id), readTables(), readOperations()]);
  if (recipe.editRevision !== layout.editRevision) throw new Error(STALE_MESSAGE);
  return { recipe, layout, tables, operations };
}
