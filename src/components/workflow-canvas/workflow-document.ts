import { DocumentSequence } from "../document-sequence";
import type { WorkflowListing, WorkflowStep } from "../workflow-model";
import type { LayoutRead } from "./placement";

/** Accepted workflow state. Polls can update presentation separately, but
 * cannot rebase a queued definition, layout or local inverse. */
export class WorkflowDocument extends DocumentSequence {
  recipe: WorkflowListing | null = null;
  layout: LayoutRead | null = null;
  constructor(readonly id: string) { super(id); }
  install(recipe: WorkflowListing, layout: LayoutRead) {
    if (recipe.editRevision !== layout.editRevision) throw new Error("This item has changed. Reload it before trying again.");
    this.recipe = recipe; this.layout = layout; this.accept(recipe);
  }
  refresh(recipe: WorkflowListing): boolean {
    if (this.pending || (this.revision && recipe.editRevision !== this.revision)) return false;
    this.recipe = recipe; this.accept(recipe); return true;
  }
  step(id: string) { return this.recipe?.steps.find((step) => step.id === id); }
  receive(value: unknown, path = "", method = "GET") {
    if (!value || typeof value !== "object") return;
    const body = value as { editRevision?: string; recipe?: WorkflowListing; step?: WorkflowStep; layout?: LayoutRead };
    this.accept(body);
    if (body.recipe) { this.recipe = body.recipe; this.accept(body.recipe); }
    if (body.layout) { this.layout = body.layout; this.accept(body.layout); }
    if (this.recipe) {
      let steps = this.recipe.steps;
      if (body.step) steps = steps.some((s) => s.id === body.step!.id) ? steps.map((s) => s.id === body.step!.id ? body.step! : s) : [...steps, body.step];
      const removed = method === "DELETE" && /\/steps\/([^/]+)$/.exec(path)?.[1];
      if (removed) steps = steps.filter((s) => s.id !== removed);
      this.recipe = { ...this.recipe, steps, ...(this.revision ? { editRevision: this.revision } : {}) };
    }
  }
  /** Inside an already reserved turn; never queues recursively. */
  send = async (path: string, init: RequestInit): Promise<Response> => {
    const response = await fetch(path, { ...init, headers: this.headers(init.headers) });
    if (response.ok) this.receive(await response.clone().json().catch(() => null), path, init.method);
    return response;
  };
  request: typeof fetch = (path, init) => this.enqueue(() => this.send(String(path), init ?? {}));
}
