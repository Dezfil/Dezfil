import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { HomeSections } from "./HomeSections";
import { SignedIn } from "../sharing/signed-in";
import type { WorkflowListing } from "../workflow-model";
import type { MapOverview } from "../api";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {} }) }));
vi.mock("../MapStrip", () => ({ MapStrip: () => null }));
afterEach(() => vi.useRealTimers());
it.each(["cards", "list"] as const)("places known, own and unknown changers in the existing %s time slot", view => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-02T14:03:00Z"));
  const maps = [
    { id: "known", lastChangedBy: { name: "Ada Okafor", sqlName: "ada" } },
    { id: "own", lastChangedBy: { name: "Bo Lindqvist", sqlName: "bo" } },
    { id: "unknown", lastChangedBy: null },
  ].map(item => ({ ...item, name: item.id, layerCount: 0, layers: [], lastChangedAt: "2026-10-02T14:00:00Z", updatedAt: "2026-10-02T14:03:00Z", owner: { name: "Owner", sqlName: "owner" } })) as unknown as MapOverview[];
  const workflows = maps.map(m => ({ ...m, origin: "workflow", summary: { nodes: 0, sources: 0, liveOutputs: 0, status: "empty", count: 0 }, steps: [] })) as unknown as WorkflowListing[];
  const html = renderToStaticMarkup(<SignedIn account={{ name: "Bo", sqlName: "bo" }}><HomeSections projectId="p" maps={maps} workflows={workflows} tables={[]} names={new Map()} lastRuns={new Map([["known", "2026-10-02T13:03:00Z"]])} view={view} groupOf={() => null} /></SignedIn>);
  expect(html).toContain("Ada · 3 min ago");
  expect(html).toContain("Unknown · 3 min ago");
  expect(html).toContain(">3 min ago</span>");
  expect(html).not.toContain("just now");
  expect(html).toContain("Ada Okafor (ada)");
  expect(html).toContain("Shared by Owner");
  expect(html.match(/Ada · 3 min ago/g)).toHaveLength(2);
  expect(html).toContain("1 h ago");
});
