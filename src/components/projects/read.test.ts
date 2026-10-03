import { afterEach, expect, it, vi } from "vitest";
import { hookReact, HookHarness } from "../workflow-canvas/hook-harness";
import type { ProjectOverview } from "./model";
vi.mock("react", () => hookReact);
import { useProjectsWorld, type ProjectsWorld } from "./read";

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.unstubAllGlobals(); });
const project = { id: "berlin", name: "Berlin mobility" } as ProjectOverview;
const added = (world: ProjectsWorld) => ({ ...world, projects: [project, ...world.projects.filter(p => p.id !== project.id)] });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function setup() {
  let release!: () => void;
  let projects: ProjectOverview[] = [];
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.stubGlobal("fetch", async (path: string) => {
    const snapshot = projects;
    await gate;
    return Response.json(path === "/api/projects" ? snapshot : path.startsWith("/api/recipes") ? { recipes: [] } : []);
  });
  const h = new HookHarness(useProjectsWorld);
  cleanups.push(() => h.unmount());
  return { h, release, setProjects(value: ProjectOverview[]) { projects = value; } };
}
it.each(["before", "after"])("keeps a created card when its completion arrives %s the initial list", async when => {
  const { h, release } = setup();
  const completeCreate = h.value.mutate;
  if (when === "before") completeCreate(added);
  release(); await tick(); h.render();
  if (when === "after") { completeCreate(added); h.render(); }
  const state = h.value.state;
  expect(state.status).toBe("ready");
  expect(state.status === "ready" ? state.value.projects.map(p => p.name) : []).toEqual(["Berlin mobility"]);
});
it("a retry replaces the edited list with its fresh answer", async () => {
  const { h, release, setProjects } = setup();
  release(); await tick(); h.render();
  h.value.mutate(added); h.render();
  setProjects([{ ...project, name: "Renamed elsewhere" }]);
  h.value.retry(); h.render(); await tick(); h.render();
  expect(h.value.state).toMatchObject({ status: "ready", value: { projects: [{ name: "Renamed elsewhere" }] } });
});
