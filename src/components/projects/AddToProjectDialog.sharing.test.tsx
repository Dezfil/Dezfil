import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDomHost, type HostElement } from "../testing/dom-host";
import { SignedIn } from "../sharing/signed-in";
import { AddToProjectDialog } from "./AddToProjectDialog";
import { AddItemsDialog } from "./AddItemsDialog";
import type { DependencyWire, FilingSubject } from "./add-model";

/**
 * Filing under sharing, as Bo, an Editor of Berlin and a Viewer of Port:
 * the dialog offers Bo's own datasets and the workflows of his own that
 * make them, each selectable on its own; another person's dependency is
 * listed as not his to add; the destinations are the projects he may file
 * into; nothing unselected is filed, and a refused compound filing changes
 * nothing and says so in the shipped note. The project-first picker offers
 * his own work and brings only what is his.
 */

vi.mock("../shell/use-project-name", () => ({ invalidateProjects: vi.fn() }));

const ada = { name: "Ada Okafor", sqlName: "ada" };
const bo = { name: "Bo Lindqvist", sqlName: "bo" };
const dep = (id: string, owner: typeof ada, producer: DependencyWire["producer"] = null): DependencyWire => ({
  id, name: id, qualifiedName: owner === bo ? id : `${owner.sqlName}.${id}`, owner, owned: owner === bo,
  source: "upload", rowCount: 3, projectIds: [], geometryColumn: "geom", geometryType: "POINT", producer,
});
const DEPS = [
  dep("stations", bo, { id: "w-bo", name: "Station catchments", owned: true }),
  dep("rents", ada, { id: "w-ada", name: "Rent pressure", owned: false }),
  dep("blocks", bo),
];
const PROJECTS = [
  { id: "mine", name: "Quay survey", mapCount: 1, tableCount: 2, role: "owner" },
  { id: "berlin", name: "Berlin housing study", mapCount: 3, tableCount: 5, role: "editor", owner: ada },
  { id: "port", name: "Port traffic", mapCount: 2, tableCount: 3, role: "viewer", owner: ada },
];

/** The workflow-origin listing: Berlin holds one workflow, Quay survey none. */
const WORKFLOWS = [{ id: "w-bo", name: "Station catchments", projectId: "berlin" }];

let calls: { url: string; method: string; body: unknown }[];
let refuse: string | null;
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let done: unknown;
beforeEach(() => {
  calls = [];
  refuse = null;
  done = null;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url: input, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (input === "/api/maps/m1/dependencies") return ok({ datasets: DEPS });
    if (input === "/api/recipes/w1/dependencies") return ok({ datasets: [] });
    if (input === "/api/projects" && method === "GET") return ok(PROJECTS);
    if (input === "/api/recipes?origin=workflow") return ok({ recipes: WORKFLOWS });
    if (input.endsWith("/members")) {
      return refuse
        ? { ok: false, status: 403, json: async () => ({ error: { code: "forbidden", message: refuse } }) }
        : ok({});
    }
    throw new Error(`unexpected ${method} ${input}`);
  }));
  host = installDomHost();
  const container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
  vi.unstubAllGlobals();
});

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const q = (selector: string) => host.document.querySelector(selector);
const all = (selector: string) => host.document.querySelectorAll(selector);
const click = async (el: HostElement | null | undefined) => {
  await act(async () => { el!.click(); });
  await settle();
};
/** The row (label) whose text holds a name. */
const row = (name: string) => all("label").find((l) => l.textContent.includes(name))!;
/** A producing workflow's own row, apart from the datasets it makes. */
const producerRow = (name: string) =>
  q("[data-producers]")!.querySelectorAll("label").find((l) => l.textContent.includes(name))!;
/** React's own change handler on a checkbox or radio: the node host fires no change events. */
async function toggle(el: HostElement) {
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"))!;
  const props = (el as unknown as Record<string, { onChange: (e: unknown) => void; checked: boolean }>)[key];
  await act(async () => props.onChange({ target: { checked: !props.checked } }));
  await settle();
}

async function openMap() {
  await act(async () => {
    root.render(
      <SignedIn account={bo}>
        <AddToProjectDialog subject={{ kind: "map", id: "m1", name: "Stations map", editRevision: "map-shown", projectId: null }}
          onClose={() => {}} onDone={(o) => { done = o; }} onWithdrawn={() => {}} />
      </SignedIn>,
    );
  });
  await settle();
  await settle();
}

describe("the Add-to-project dialog as an Editor", () => {
  it("offers only the projects Bo may file into", async () => {
    await openMap();
    const destinations = all('input[name="add-destination"]').map((r) => r.parentElement!.textContent);
    expect(destinations.some((t) => t.includes("Quay survey"))).toBe(true);
    expect(destinations.some((t) => t.includes("Berlin housing study"))).toBe(true);
    expect(destinations.some((t) => t.includes("Port traffic"))).toBe(false);
  });

  it("counts a destination's workflows as the share dialog does, beside its maps and datasets", async () => {
    await openMap();
    const meta = (name: string) => all('input[name="add-destination"]').find((r) => r.parentElement!.textContent.includes(name))!
      .parentElement!.textContent;
    expect(meta("Berlin housing study")).toContain("3 maps · 1 workflow · 5 datasets");
    expect(meta("Quay survey")).toContain("1 map · 2 datasets");
    expect(meta("Quay survey")).not.toContain("workflow");
  });

  it("starts with Bo's own datasets and the workflow of his that makes them, each a box of its own", async () => {
    await openMap();
    const box = (name: string) => row(name).querySelector('input[type="checkbox"]')!;
    expect(box("stations").checked).toBe(true);
    expect(box("blocks").checked).toBe(true);
    expect(producerRow("Station catchments").querySelector('input[type="checkbox"]')!.checked).toBe(true);
  });

  it("lists Ada's dataset and her workflow as not his to add, with no box to tick", async () => {
    await openMap();
    for (const r of [row("ada.rents"), producerRow("Rent pressure")]) {
      const name = r.textContent;
      expect(r.hasAttribute("data-not-addable"), name).toBe(true);
      expect(r.textContent).toContain("not yours to add");
      expect(r.querySelector('input[type="checkbox"]')?.disabled ?? true).toBe(true);
    }
  });

  it("files what is picked and nothing else: a dataset without its workflow", async () => {
    await openMap();
    await toggle(producerRow("Station catchments").querySelector('input[type="checkbox"]')!);
    await toggle(row("Berlin housing study").querySelector('input[type="radio"]')!);
    const confirm = all("button").find((b) => b.textContent.startsWith("Add 3 items to Berlin housing study"));
    expect(confirm, "the footer counts the map and two datasets").toBeTruthy();
    await click(confirm);
    expect(calls.find((c) => c.method === "PATCH")).toEqual({
      url: "/api/projects/berlin/members",
      method: "PATCH",
      body: { addMaps: ["m1"], addTables: ["stations", "blocks"], addRecipes: [], expectedRevisions: { "map:m1": "map-shown" } },
    });
    expect(done).toMatchObject({ projectId: "berlin", datasetIds: ["stations", "blocks"], workflowIds: [] });
  });

  it("says a refused compound filing in the shipped note and keeps every choice", async () => {
    await openMap();
    refuse = "You can view this but cannot make this change.";
    await toggle(row("Berlin housing study").querySelector('input[type="radio"]')!);
    await click(all("button").find((b) => b.textContent.startsWith("Add 4 items")));
    expect(host.document.body.textContent).toContain("You can view this but cannot make this change.");
    expect(done).toBeNull();
    expect(row("stations").querySelector('input[type="checkbox"]')!.checked).toBe(true);
  });
});

describe("the project-first picker as an Editor", () => {
  it("offers Bo's own work alone and names what a picked map leaves out", async () => {
    await act(async () => {
      root.render(
        <SignedIn account={bo}>
          <AddItemsDialog projectId="berlin" projectName="Berlin housing study"
            catalogue={{ status: "ready", value: {
              maps: [{ id: "m1", name: "Stations map", editRevision: "map-shown", projectId: null, layerCount: 2, owner: bo },
                { id: "m2", name: "Rent map", projectId: "port", layerCount: 1, owner: ada }] as never,
              workflows: [], tables: [],
            } }}
            names={new Map()} members={{ workflows: new Set(), tables: new Set() }}
            onRetryCatalogue={() => {}} onClose={() => {}} onDone={() => {}} />
        </SignedIn>,
      );
    });
    await settle();
    expect(all("[data-picker-row]").map((r) => r.textContent).join()).not.toContain("Rent map");
    await toggle(all('input[type="checkbox"]')[0]);
    await settle();
    const sub = q("[data-picker-sub]")!.textContent;
    expect(sub).toContain("brings stations, blocks");
    expect(sub).toContain("ada.rents is not yours to add");
  });
});

describe("one's own work still filed in a project one no longer reaches", () => {
  let withdrawn: unknown;
  async function open(subject: FilingSubject) {
    withdrawn = null;
    // Each opening is a fresh dialog, as the lists mount it.
    act(() => root.render(null));
    await act(async () => {
      root.render(
        <SignedIn account={bo}>
          <AddToProjectDialog subject={subject} onClose={() => {}} onDone={(o) => { done = o; }}
            onWithdrawn={(o) => { withdrawn = o; }} />
        </SignedIn>,
      );
    });
    await settle();
    await settle();
  }
  const takeOut = () => all("button").find((b) => b.textContent === "Take it out");
  const patch = () => calls.filter((c) => c.method === "PATCH");

  it("offers to take a dataset out of it, by the identity its reads report", async () => {
    await open({ kind: "dataset", id: "customers", name: "customers", projectIds: ["gone", "mine"] });
    expect(host.document.body.textContent).toContain("In a project you no longer reach.");
    await click(takeOut());
    expect(patch()).toEqual([{ url: "/api/projects/gone/members", method: "PATCH", body: { removeTables: ["customers"], expectedRevisions: {} } }]);
    expect(withdrawn).toEqual({ projectIds: ["gone"] });
    expect(done).toBeNull();
  });

  it("takes a map or a workflow out by its own kind", async () => {
    await open({ kind: "map", id: "m1", name: "Stations map", editRevision: "map-shown", projectId: "gone" });
    await click(takeOut());
    await open({ kind: "workflow", id: "w1", name: "Station catchments", editRevision: "workflow-shown", projectId: "gone" });
    await click(takeOut());
    expect(patch().map((c) => [c.url, c.body])).toEqual([
      ["/api/projects/gone/members", { removeMaps: ["m1"], expectedRevisions: { "map:m1": "map-shown" } }],
      ["/api/projects/gone/members", { removeRecipes: ["w1"], expectedRevisions: { "workflow:w1": "workflow-shown" } }],
    ]);
  });

  it("says nothing of the kind for work filed only where one reaches, a Viewer's project included", async () => {
    await open({ kind: "dataset", id: "stations", name: "stations", projectIds: ["mine", "port"] });
    expect(host.document.body.textContent).not.toContain("no longer reach");
    expect(takeOut()).toBeUndefined();
  });

  it("keeps the dialog and says a refused withdrawal in the shipped note", async () => {
    await open({ kind: "dataset", id: "customers", name: "customers", projectIds: ["gone"] });
    refuse = "The resource was not found.";
    await click(takeOut());
    expect(host.document.body.textContent).toContain("The resource was not found.");
    expect(withdrawn).toBeNull();
    expect(takeOut()).toBeTruthy();
  });
});
