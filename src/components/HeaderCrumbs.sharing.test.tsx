import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { HeaderCrumbs } from "./NavLinks";

/**
 * The header path's project segment on a filed map or workflow: when the
 * project is shared it carries the Projects page's people mark, and the
 * segment still leads to the project home. An unfiled map shows no project
 * segment and so no mark; a project nobody else reaches shows its name
 * alone.
 */

type Fact = { name: string; role?: "owner" | "editor" | "viewer"; owner?: { name: string; sqlName: string } };
const state = vi.hoisted(() => ({
  object: null as { name: string; projectId: string | null } | null,
  facts: new Map<string, Fact>(),
  people: new Map<string, { name: string; sqlName: string; role: "owner" | "editor" | "viewer"; deactivated: boolean }[]>(),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/maps/m1" }));
vi.mock("@/components/shell/path-model", () => ({ usePathObject: () => state.object }));
vi.mock("@/components/shell/use-project-name", () => ({
  useProjectFact: (id: string | null) => (id ? (state.facts.get(id) ?? null) : null),
}));
vi.mock("@/components/sharing/use-project-people", () => ({
  useProjectPeople: (ids: string[]) => new Map(ids.flatMap((id) => (state.people.has(id) ? [[id, state.people.get(id)!]] : []))),
}));

const bo = { name: "Bo Lindqvist", sqlName: "bo" };
const ada = { name: "Ada Okafor", sqlName: "ada" };

describe("the header path's project segment", () => {
  it("carries the people count on a filed map whose project one shares, and still leads home", () => {
    state.object = { name: "Berth occupancy", projectId: "port" };
    state.facts = new Map([["port", { name: "Port traffic", role: "owner", owner: bo }]]);
    state.people = new Map([["port", [
      { name: "Bo Lindqvist", sqlName: "bo", role: "owner", deactivated: false },
      { name: "Ada Okafor", sqlName: "ada", role: "editor", deactivated: false },
    ]]]);
    const html = renderToStaticMarkup(<HeaderCrumbs />);
    const segment = html.slice(html.indexOf('href="/projects/port"'), html.indexOf("</a>"));
    expect(segment).toContain("Port traffic");
    expect(segment).toContain('data-people="sharing"');
    expect(segment).toContain('data-hint="Shared with Ada"');
  });

  it("carries the owner and one's role on a filed workflow in a project shared with one", () => {
    state.object = { name: "Permit geocoding", projectId: "berlin" };
    state.facts = new Map([["berlin", { name: "Berlin housing study", role: "viewer", owner: ada }]]);
    state.people = new Map();
    const html = renderToStaticMarkup(<HeaderCrumbs />);
    const segment = html.slice(html.indexOf('href="/projects/berlin"'), html.indexOf("</a>"));
    expect(segment).toContain("by Ada · Viewer");
  });

  it("names a project only its owner reaches without a mark", () => {
    state.object = { name: "Scratch", projectId: "quay" };
    state.facts = new Map([["quay", { name: "Quay survey", role: "owner", owner: bo }]]);
    state.people = new Map([["quay", [{ name: "Bo Lindqvist", sqlName: "bo", role: "owner", deactivated: false }]]]);
    const html = renderToStaticMarkup(<HeaderCrumbs />);
    expect(html).toContain("Quay survey");
    expect(html).not.toContain("data-people");
  });

  it("shows nothing new on an unfiled map", () => {
    state.object = { name: "Scratch", projectId: null };
    const html = renderToStaticMarkup(<HeaderCrumbs />);
    expect(html).not.toContain("/projects/");
    expect(html).not.toContain("data-people");
  });
});
