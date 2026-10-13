import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapOverview, TableListing } from "../api";
import { HostEvent, installDomHost, type HostElement } from "../testing/dom-host";
import { SignedIn } from "../sharing/signed-in";
import type { WorkflowListing } from "../workflow-model";
import { recentItems } from "./recent-model";
import { RecentCard, RecentRow } from "./RecentList";

/**
 * The recent rows in their opening form, as Bo reads them at 15:00 with no
 * project to file into: Ada's map Survey in Berlin, changed by her at
 * 14:00; his unfiled workflow Flow at 13:00; his dataset roads in Atlas
 * and Berlin at 12:00; his map Depot, filed in a project he no longer
 * reaches, at 11:00. Each row is the link to its item, named by the item
 * with the owner's name after it on someone else's, and offers neither Add
 * nor Move; the line under the name says where it lives, one fact and who
 * changed it when, the time alone for a dataset.
 */

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));
vi.mock("../MapStrip", () => ({ MapStrip: () => null }));
vi.mock("../WorkflowThumb", () => ({ WorkflowThumb: () => null }));

const ada = { name: "Ada Okafor", sqlName: "ada" };
const bo = { name: "Bo Lindqvist", sqlName: "bo" };
const map = (id: string, name: string, owner: typeof ada, projectId: string | null, at: string) =>
  ({ id, name, owner, projectId, layerCount: 2, updatedAt: at, lastChangedAt: at, lastChangedBy: owner }) as unknown as MapOverview;
const flow = {
  id: "w-bo", name: "Flow", owner: bo, origin: "workflow", projectId: null,
  updatedAt: "2026-10-02T13:00:00Z", lastChangedAt: "2026-10-02T13:00:00Z", lastChangedBy: bo,
  summary: { nodes: 3, sources: 1, liveOutputs: 0, status: "up_to_date", count: 0 }, steps: [],
} as unknown as WorkflowListing;
const roads = {
  id: "t-bo", name: "roads", qualifiedName: "roads", owner: bo, projectIds: ["atlas", "berlin"], rowCount: 1,
  geometryColumn: null, geometryType: null, importedAt: "2026-10-02T12:00:00Z", createdAt: "2026-10-01T12:00:00Z",
} as unknown as TableListing;
const ITEMS = recentItems({
  maps: [map("m-ada", "Survey", ada, "berlin", "2026-10-02T14:00:00Z"), map("m-bo", "Depot", bo, "gone", "2026-10-02T11:00:00Z")],
  workflows: [flow],
  tables: [roads],
  names: new Map([["berlin", "Berlin"], ["atlas", "Atlas"]]),
  me: "bo",
  ties: "total",
});

let host: ReturnType<typeof installDomHost>;
let container: HostElement;
let root: ReturnType<typeof createRoot>;
beforeEach(async () => {
  nav.push.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-02T15:00:00Z"));
  host = installDomHost();
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
  await act(async () => {
    root.render(
      <SignedIn account={bo}>
        <RecentCard heading="Recent">
          {ITEMS.map((it) => (
            <RecentRow key={it.id} item={it} groupOf={() => null} form={{ kind: "opening" }} />
          ))}
        </RecentCard>
      </SignedIn>,
    );
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
  vi.useRealTimers();
});

const rows = () => container.querySelectorAll("[data-recent-row]");
const press = (el: HostElement, key: string) =>
  act(async () => { el.dispatchEvent(Object.assign(new HostEvent("keydown", { bubbles: true, cancelable: true }), { key })); });

describe("an opening recent row", () => {
  it("is a link named by its item, with the owner's name after it on someone else's", () => {
    expect(rows().map((r) => r.getAttribute("role"))).toEqual(["link", "link", "link", "link"]);
    expect(rows().map((r) => r.getAttribute("tabindex"))).toEqual(["0", "0", "0", "0"]);
    expect(rows().map((r) => r.getAttribute("aria-label"))).toEqual(["Survey, Ada Okafor", "Flow", "roads", "Depot"]);
    expect(rows().map((r) => r.querySelector("[data-owner-pill]")?.getAttribute("data-owner-pill") ?? null)).toEqual(["ada", null, null, null]);
  });

  it("offers neither Add nor Move, even on one's own work", () => {
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.querySelectorAll("[data-recent-action]")).toHaveLength(0);
  });

  it("says where its item lives, one fact, and who changed it when, the time alone for a dataset", () => {
    expect(rows().map((r) => r.querySelector("[data-recent-meta]")?.textContent)).toEqual([
      "in Berlin·2 layers·Ada · 1 h ago",
      "not in a project·3 nodes·2 h ago",
      "in Atlas, Berlin·1 row · No geometry·3 h ago",
      "in a project you no longer reach·2 layers·4 h ago",
    ]);
    expect(rows().map((r) => r.querySelector("[data-last-changed]") !== null)).toEqual([true, true, false, true]);
  });

  it("opens its item on a click or on Enter, and on no other key", async () => {
    const [survey, flowRow, roadsRow, depot] = rows();
    await act(async () => survey.click());
    expect(nav.push).toHaveBeenLastCalledWith("/maps/m-ada");
    await press(flowRow, "Enter");
    expect(nav.push).toHaveBeenLastCalledWith("/workflows/w-bo");
    await act(async () => roadsRow.click());
    expect(nav.push).toHaveBeenLastCalledWith("/tables/roads");
    await press(depot, "Enter");
    expect(nav.push).toHaveBeenLastCalledWith("/maps/m-bo");
    await press(depot, " ");
    await press(depot, "Tab");
    expect(nav.push).toHaveBeenCalledTimes(4);
  });
});
