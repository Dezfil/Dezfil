import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { DocumentEditorContext } from "../../document-editor-context";
import { DocumentSequence } from "../../document-sequence";
import { useAuthorStep, type AuthorStepPort } from "./use-author-step";
import type { RecipeSummary } from "./recipe-model";

it("chains accepted workflow bases and lands its result through the builder sequence", async () => {
  const calls: { path: string; headers: Headers }[] = [];
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (path, init) => {
    calls.push({ path: String(path), headers: new Headers(init?.headers) });
    if (path === "/api/recipes") return Response.json({ recipe: { id: "r", editRevision: "created" } });
    if (path === "/api/recipes/r/steps") return Response.json({ step: { id: "s" }, editRevision: "step-added" });
    if (path === "/api/recipes/r/steps/s/run") return Response.json({ run: { id: "run", members: [{ jobId: "job" }] } });
    if (path === "/api/operations/runs/job") return Response.json({ run: { state: "succeeded", output: { id: "data", name: "output" } } });
    if (path === "/api/tables/output") return Response.json({ geometryColumn: "geometry", rowCount: 1 });
    throw new Error(`Unsequenced write: ${path}`);
  });
  const request = vi.fn<typeof fetch>(async () => Response.json({ id: "layer", editRevision: "landed" }));
  let port!: AuthorStepPort;
  function Probe() { port = useAuthorStep({ mapId: "map", onSettled() {} }); return null; }
  try {
    renderToStaticMarkup(<DocumentEditorContext.Provider value={{ sequence: new DocumentSequence("map"), request, turn: work => work() }}><Probe /></DocumentEditorContext.Provider>);
    const result = await port.author({ recipeId: null, recipeName: "Work", step: { operation: "sql_step", parameters: { sql: "SELECT 1" }, displayName: "Output" }, onRecipe() {} });
    expect(calls.find(c => c.path === "/api/recipes/r/steps")?.headers.get("X-Edit-Revision")).toBe("created");
    expect(calls.find(c => c.path.endsWith("/s/run"))?.headers.get("X-Edit-Revision")).toBe("step-added");
    expect(request).toHaveBeenCalledWith("/api/maps/map/layers", expect.objectContaining({ method: "POST" }));
    expect(result?.layerId).toBe("layer");
  } finally { fetcher.mockRestore(); }
});

it("does not attach a cleanup read's newer token to the already composed retry", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (path) => {
    if (path === "/api/recipes") return Response.json({ recipes: [{ id: "r", editRevision: "newer", steps: [{ id: "s", output: null }] }] });
    return Response.json({ error: { message: "This item has changed. Reload it before trying again." } }, { status: 409 });
  });
  let port!: AuthorStepPort;
  function Probe() { port = useAuthorStep({ mapId: "map", onSettled() {} }); return null; }
  try {
    renderToStaticMarkup(<Probe />);
    const result = await port.author({ recipeId: "r", recipe: { id: "r", editRevision: "shown" } as RecipeSummary,
      recipeName: "Work", step: { operation: "sql_step", parameters: { sql: "SELECT 1" }, displayName: "Output" }, onRecipe() {} });
    expect(result).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(new Headers(fetcher.mock.calls[1][1]?.headers).get("X-Edit-Revision")).toBe("shown");
  } finally { fetcher.mockRestore(); }
});
