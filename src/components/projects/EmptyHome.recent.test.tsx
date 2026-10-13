import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapOverview, TableListing } from "../api";
import { installDomHost, type HostElement } from "../testing/dom-host";
import { SignedIn } from "../sharing/signed-in";
import type { WorkflowListing } from "../workflow-model";
import type { CatalogueState } from "./home-read";
import { EmptyHome } from "./EmptyHome";

/**
 * The empty project's recent card as Bo reads it at 15:00: Ada's map Survey
 * in Berlin changed by her at 14:00, his unfiled workflow Flow at 13:00, his
 * dataset roads in Atlas and in a project he no longer reaches at 12:00,
 * and his map Depot in Atlas at 11:00, changed by no account the record
 * names. Each row says its kind, its name, someone else's owner, where it
 * lives, one fact and who changed it when (the time alone for a dataset),
 * and offers Add or Move on Bo's own work alone.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../MapStrip", () => ({ MapStrip: () => null }));
vi.mock("../WorkflowThumb", () => ({ WorkflowThumb: () => null }));

const ada = { name: "Ada Okafor", sqlName: "ada" };
const bo = { name: "Bo Lindqvist", sqlName: "bo" };
const map = (id: string, name: string, owner: typeof ada, projectId: string | null, at: string, by: typeof ada | null, layerCount = 2) =>
  ({ id, name, owner, projectId, layerCount, updatedAt: at, lastChangedAt: at, lastChangedBy: by }) as unknown as MapOverview;
const flow = {
  id: "w-bo", name: "Flow", owner: bo, origin: "workflow", projectId: null,
  updatedAt: "2026-10-02T13:00:00Z", lastChangedAt: "2026-10-02T13:00:00Z", lastChangedBy: bo,
  summary: { nodes: 3, sources: 1, liveOutputs: 0, status: "up_to_date", count: 0 }, steps: [],
} as unknown as WorkflowListing;
const roads = {
  id: "t-bo", name: "roads", qualifiedName: "roads", owner: bo, projectIds: ["atlas", "ghost"], rowCount: 1860,
  geometryColumn: "geom", geometryType: "POINT", importedAt: "2026-10-02T12:00:00Z", createdAt: "2026-10-01T12:00:00Z",
} as unknown as TableListing;
const ready = (value: { maps: MapOverview[]; workflows: WorkflowListing[]; tables: TableListing[] }): CatalogueState =>
  ({ status: "ready", value });
const WORLD = ready({
  maps: [
    map("m-ada", "Survey", ada, "berlin", "2026-10-02T14:00:00Z", ada),
    map("m-bo", "Depot", bo, "atlas", "2026-10-02T11:00:00Z", null, 1),
  ],
  workflows: [flow],
  tables: [roads],
});
const names = new Map([["berlin", "Berlin"], ["atlas", "Atlas"]]);
const none = { maps: new Set<string>(), workflows: new Set<string>(), tables: new Set<string>() };

let host: ReturnType<typeof installDomHost>;
let container: HostElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-02T15:00:00Z"));
  host = installDomHost();
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
  vi.useRealTimers();
});

const props = {
  onAdd: vi.fn(), onNewMap: vi.fn(), onNewWorkflow: vi.fn(), onAddData: vi.fn(), onRetryCatalogue: vi.fn(),
};
const mount = (catalogue: CatalogueState, over: { busyId?: string | null; instanceName?: string | null } = {}) =>
  act(async () => {
    root.render(
      <SignedIn account={bo}>
        <EmptyHome
          projectId="home" projectName="Home" instanceName={over.instanceName === undefined ? "Stadtwerke" : over.instanceName}
          catalogue={catalogue} exclude={none} names={names} groupOf={() => null} busyId={over.busyId ?? null}
          creatingMap={false} {...props}
        />
      </SignedIn>,
    );
  });
const rows = () => container.querySelectorAll("[data-recent-row]");
const text = (el: HostElement | null | undefined) => el?.textContent ?? null;
const button = (label: string) => container.querySelectorAll("button").find((b) => b.getAttribute("aria-label") === label);

describe("the empty project's recent rows", () => {
  it("say the kind, the name, someone else's owner, where it lives, one fact and who changed it when", async () => {
    await mount(WORLD);
    expect(rows().map((r) => r.getAttribute("data-recent-row"))).toEqual(["map", "workflow", "dataset", "map"]);
    expect(rows().map((r) => text(r.querySelector("[data-recent-kind]")))).toEqual(["Map", "Workflow", "Dataset", "Map"]);
    expect(rows().map((r) => text(r.querySelector("[data-recent-name]")))).toEqual(["Survey", "Flow", "roads", "Depot"]);
    expect(rows().map((r) => r.querySelector("[data-owner-pill]")?.getAttribute("data-owner-pill") ?? null)).toEqual(["ada", null, null, null]);
    expect(rows()[0].querySelector("[data-owner-pill]")?.getAttribute("data-placement")).toBe("inline");
    expect(rows().map((r) => text(r.querySelector("[data-recent-where]")))).toEqual([
      "in Berlin", "not in a project", "in Atlas, a project you no longer reach", "in Atlas",
    ]);
    expect(rows().map((r) => text(r.querySelector("[data-recent-meta]")))).toEqual([
      "in Berlin·2 layers·Ada · 1 h ago",
      "not in a project·3 nodes·2 h ago",
      "in Atlas, a project you no longer reach·1,860 rows · Points·3 h ago",
      "in Atlas·1 layer·Unknown · 4 h ago",
    ]);
    expect(rows().map((r) => r.querySelector("[data-last-changed]") !== null)).toEqual([true, true, false, true]);
  });

  it("offer Add on one's own unfiled or dataset row, Move on one's own filed map or workflow, nothing on someone else's", async () => {
    await mount(WORLD);
    expect(rows().map((r) => r.querySelector("[data-recent-action]")?.getAttribute("data-recent-action") ?? null)).toEqual([null, "add", "add", "move"]);
    expect(rows().map((r) => r.querySelector("button")?.getAttribute("aria-label") ?? null)).toEqual([null, "Add Flow", "Add roads", "Move Depot"]);
    await act(async () => button("Add Flow")!.click());
    expect(props.onAdd).toHaveBeenCalledTimes(1);
    expect(props.onAdd.mock.calls[0][0]).toMatchObject({ kind: "workflow", id: "w-bo", name: "Flow" });
  });

  it("wait on the row whose Add is in flight and hold the others", async () => {
    await mount(WORLD, { busyId: "t-bo" });
    expect(button("Add roads")!.getAttribute("aria-busy")).toBe("true");
    expect(["Add Flow", "Add roads", "Move Depot"].map((l) => button(l)!.disabled)).toEqual([true, true, true]);
    expect(button("Add Flow")!.getAttribute("aria-busy")).toBeNull();
  });

  it("keep equal times in the lists' order", async () => {
    const at = "2026-10-02T14:00:00Z";
    await mount(ready({ maps: [map("m-b", "B", bo, null, at, bo), map("m-a", "A", bo, null, at, bo)], workflows: [], tables: [] }));
    expect(rows().map((r) => text(r.querySelector("[data-recent-name]")))).toEqual(["B", "A"]);
  });
});

describe("the empty project's recent card", () => {
  it("heads by the instance and says none of the rows is in the project", async () => {
    await mount(WORLD);
    expect(text(container.querySelector("[data-recent-heading]"))).toBe("Recent in Stadtwerke");
    expect(text(container.querySelector("[data-recent-hint]"))).toBe("none of these is in Home");
  });

  it("heads plainly for an unnamed instance and says when nothing is recent, without the hint", async () => {
    await mount(ready({ maps: [], workflows: [], tables: [] }), { instanceName: null });
    expect(text(container.querySelector("[data-recent-heading]"))).toBe("Recent");
    expect(text(container.querySelector("[data-recent-none]"))).toBe("Nothing recent yet.");
    expect(container.querySelector("[data-recent-hint]")).toBeNull();
  });

  it("says it is loading, then a failure with Try again, and nothing before the read starts", async () => {
    await mount({ status: "pending" });
    expect(text(container.querySelector("[data-recent]"))).toBe("Recent in StadtwerkeLoading recent items…");
    await mount({ status: "failed", error: "The workspace couldn't be read." });
    expect(text(container.querySelector('[role="alert"]'))).toContain("The workspace couldn't be read.");
    await act(async () => container.querySelectorAll("button").find((b) => b.textContent === "Try again")!.click());
    expect(props.onRetryCatalogue).toHaveBeenCalledTimes(1);
    await mount({ status: "idle" });
    expect(text(container.querySelector("[data-recent]"))).toBe("Recent in Stadtwerke");
    expect(rows()).toHaveLength(0);
  });
});
