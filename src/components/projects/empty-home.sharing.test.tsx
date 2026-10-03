import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapOverview, TableListing } from "../api";
import { installDomHost, type HostElement } from "../testing/dom-host";
import { SignedIn } from "../sharing/signed-in";
import { EmptyHome } from "./EmptyHome";

/**
 * The empty project's recent list as Bo reads it. Ada's map sits in Berlin,
 * a project Bo only views; Bo's own map sits in Atlas. Ada and Bo each own a
 * `roads` of one row. Bo may move or add only his own work: Ada's rows offer
 * neither and carry her owner pill, so the two `roads` never look the same.
 */

vi.mock("../MapStrip", () => ({ MapStrip: () => null }));
vi.mock("../WorkflowThumb", () => ({ WorkflowThumb: () => null }));

const ada = { name: "Ada Okafor", sqlName: "ada" };
const bo = { name: "Bo Lindqvist", sqlName: "bo" };
const map = (id: string, name: string, owner: typeof ada, projectId: string, updatedAt: string) =>
  ({ id, name, owner, projectId, layerCount: 1, updatedAt, lastChangedAt: updatedAt, lastChangedBy: owner, home: owner.sqlName }) as unknown as MapOverview;
const roads = (id: string, owner: typeof ada, projectIds: string[], importedAt: string) =>
  ({
    id, name: "roads", qualifiedName: owner === bo ? "roads" : `${owner.sqlName}.roads`, owner, projectIds,
    rowCount: 1, geometryColumn: "geom", geometryType: "LINESTRING", importedAt, createdAt: importedAt,
  }) as unknown as TableListing;

const catalogue = {
  status: "ready" as const,
  value: {
    maps: [map("m-ada", "Survey", ada, "berlin", "2026-09-04T00:00:00Z"), map("m-bo", "Depot", bo, "atlas", "2026-09-03T00:00:00Z")],
    workflows: [],
    tables: [roads("t-ada", ada, ["berlin"], "2026-09-02T00:00:00Z"), roads("t-bo", bo, [], "2026-09-01T00:00:00Z")],
  },
};
const names = new Map([["berlin", "Berlin"], ["atlas", "Atlas"]]);
const none = { maps: new Set<string>(), workflows: new Set<string>(), tables: new Set<string>() };

let host: ReturnType<typeof installDomHost>;
let container: HostElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  host = installDomHost();
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
});

const mount = () => act(async () => {
  root.render(
    <SignedIn account={bo}>
      <EmptyHome
        projectId="home" projectName="Home" instanceName={null} catalogue={catalogue} exclude={none} names={names}
        groupOf={() => null} busyId={null} creatingMap={false} onAdd={vi.fn()} onNewMap={vi.fn()}
        onNewWorkflow={vi.fn()} onAddData={vi.fn()} onRetryCatalogue={vi.fn()}
      />
    </SignedIn>,
  );
  await new Promise((r) => setTimeout(r, 0));
});
/** The rows newest first: Ada's map, Bo's map, Ada's roads, Bo's roads. */
const ORDER = ["m-ada", "m-bo", "t-ada", "t-bo"];
const row = (id: string) => container.querySelectorAll("[data-recent-row]")[ORDER.indexOf(id)] ?? null;
const action = (id: string) => row(id)?.querySelector("[data-recent-action]")?.getAttribute("data-recent-action") ?? null;
const pill = (id: string) => row(id)?.querySelector("[data-owner-pill]")?.getAttribute("data-owner-pill") ?? null;

describe("the empty project's recent list for a member", () => {
  it("offers Move and Add on the reader's own work alone", async () => {
    await mount();
    expect(container.querySelectorAll("[data-recent-name]").map((name) => name.textContent)).toEqual(["Survey", "Depot", "roads", "roads"]);
    expect(["m-ada", "m-bo", "t-ada", "t-bo"].map(action)).toEqual([null, "move", null, "add"]);
  });

  it("marks someone else's work with its owner's pill, so two people's roads differ", async () => {
    await mount();
    expect(["m-ada", "m-bo", "t-ada", "t-bo"].map(pill)).toEqual(["ada", null, "ada", null]);
    expect(row("t-ada")?.querySelector("[data-recent-name]")?.textContent).toBe("roads");
  });

  it("counts one row as a row", async () => {
    await mount();
    expect(row("t-bo")?.querySelector("[data-recent-meta]")?.textContent).toContain("1 row ·");
  });
});
