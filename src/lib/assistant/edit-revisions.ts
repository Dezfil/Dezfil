import type { ToolDef } from "@/lib/tools/tools";
import { EDIT_REVISION_HEADER } from "@/lib/edit-basis";

export function withoutWriteRevision(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== EDIT_REVISION_HEADER.toLowerCase()));
}
export function callPath(tool: ToolDef, args: Record<string, unknown>): string {
  return tool.path.replace(/\{([^}]+)\}/g, (_, key: string) => encodeURIComponent(String(args[key] ?? "")));
}
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** One executing segment owns these facts. Nothing here is parked. Reads
 * learn only their paired tokens; accepted writes replace the token for their
 * own parent. A missing basis remains missing, never a pre-write reread. */
export class AssistantRevisions {
  private revisions = new Map<string, string>();
  private parents = new Map<string, string>();
  revision(key: string) { return this.revisions.get(key); }
  private document(path: string): string | undefined {
    const parent = /^\/api\/(maps|recipes)\/([^/]+)/.exec(path);
    if (parent) return `${parent[1] === "maps" ? "map" : "workflow"}:${decodeURIComponent(parent[2])}`;
    return this.parents.get(path.replace(/\/(duplicate|features).*$/, ""));
  }
  headers(tool: ToolDef, args: Record<string, unknown>): Record<string, string> {
    if (!tool.headerParams?.some((p) => p.name.toLowerCase() === EDIT_REVISION_HEADER.toLowerCase())) return {};
    const key = this.document(callPath(tool, args));
    const revision = key && this.revisions.get(key);
    return revision ? { [EDIT_REVISION_HEADER]: revision } : {};
  }
  bodyArguments(tool: ToolDef, args: Record<string, unknown>): Record<string, unknown> {
    if (!tool.compoundRevisionPath) return args;
    const members = tool.compoundRevisionPath === "self" ? args : record(args.members);
    if (!members) return args;
    const expectedRevisions = Object.fromEntries(filingDocuments(members).flatMap(key => {
      const revision = this.revisions.get(key);
      return revision ? [[key, revision]] : [];
    }));
    return tool.compoundRevisionPath === "self" ? { ...args, expectedRevisions }
      : { ...args, members: { ...members, expectedRevisions } };
  }
  /** Resume is an explicit new admission after a confirmation wait. */
  async readOnResume(tool: ToolDef, args: Record<string, unknown>, baseUrl: string, fetchImpl: typeof fetch, signal?: AbortSignal) {
    if (tool.compoundRevisionPath) {
      const members = tool.compoundRevisionPath === "self" ? args : record(args.members);
      for (const key of filingDocuments(members ?? {})) {
        const colon = key.indexOf(":");
        const path = `/api/${key.slice(0, colon) === "map" ? "maps" : "recipes"}/${encodeURIComponent(key.slice(colon + 1))}`;
        const response = await fetchImpl(baseUrl.replace(/\/$/, "") + path, { signal });
        if (response.ok) this.observe(path, await response.json());
      }
      return;
    }
    if (!tool.headerParams?.some((p) => p.name.toLowerCase() === EDIT_REVISION_HEADER.toLowerCase())) return;
    const path = callPath(tool, args);
    const match = /^\/api\/(maps|recipes|layers|sketches)\/[^/]+/.exec(path);
    if (!match) return;
    const response = await fetchImpl(baseUrl.replace(/\/$/, "") + match[0], { signal });
    if (response.ok) this.observe(match[0], await response.json());
  }
  observe(path: string, value: unknown): void {
    path = path.split("?")[0];
    if (Array.isArray(value)) { for (const item of value) this.observe(path, item); return; }
    const body = record(value);
    if (!body) return;
    const duplication = /^\/api\/(maps|recipes)\/[^/]+\/duplicate$/.exec(path);
    if (duplication) {
      const copy = record(body.recipe) ?? body;
      if (typeof copy.id !== "string") return;
      path = `/api/${duplication[1]}/${encodeURIComponent(copy.id)}`;
    }
    if (body.recipe) this.observe(path, body.recipe);
    const key = typeof body.mapId === "string" ? `map:${body.mapId}`
      : typeof body.recipeId === "string" ? `workflow:${body.recipeId}`
      : typeof body.id === "string" && path === "/api/maps" ? `map:${body.id}`
      : typeof body.id === "string" && path === "/api/recipes" ? `workflow:${body.id}`
      : this.document(path);
    if (key) {
      if (typeof body.editRevision === "string") this.revisions.set(key, body.editRevision);
      if (typeof body.mapId === "string" && typeof body.id === "string") this.parents.set(`/api/layers/${encodeURIComponent(body.id)}`, key);
      if (typeof body.table === "string") this.parents.set(`/api/sketches/${encodeURIComponent(body.table)}`, key);
      if (Array.isArray(body.layers)) for (const layer of body.layers) {
        const child = record(layer);
        if (typeof child?.id === "string") this.parents.set(`/api/layers/${encodeURIComponent(child.id)}`, key);
      }
    }
    for (const name of ["maps", "recipes", "workflows", "revisions"]) {
      if (!Array.isArray(body[name])) continue;
      for (const item of body[name]) {
        const row = record(item);
        if (row?.kind === "map" || row?.kind === "workflow") {
          if (typeof row.id === "string" && typeof row.editRevision === "string") this.revisions.set(`${row.kind}:${row.id}`, row.editRevision);
        } else this.observe(name === "maps" ? "/api/maps" : "/api/recipes", item);
      }
    }
  }
}

function filingDocuments(members: Record<string, unknown>): string[] {
  return [...new Set((["addMaps", "removeMaps", "addRecipes", "removeRecipes"] as const).flatMap(field => {
    const ids = members[field];
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string")
      .map(id => `${field.endsWith("Maps") ? "map" : "workflow"}:${id}`) : [];
  }))];
}
