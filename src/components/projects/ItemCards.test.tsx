import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MapOverview } from "../api";
import { cssRules, outranks, reachesInState, specificity } from "../testing/css-rules";
import { installDomHost, type HostElement } from "../testing/dom-host";
import { SignedIn } from "../sharing/signed-in";
import type { WorkflowListing } from "../workflow-model";
import { MapCard, WorkflowCard } from "./ItemCards";

/**
 * A map's and a workflow's card standing alone, in no project's grid: each
 * keeps its time on hover and focus where the gallery would fade it, so a
 * page that hosts one card draws it as a project's home does.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../MapStrip", () => ({ MapStrip: () => null }));
vi.mock("../WorkflowThumb", () => ({ WorkflowThumb: () => null }));

const AT = "2026-10-02T14:00:00Z";
const ada = { name: "Ada Okafor", sqlName: "ada" };
const depot = {
  id: "m", name: "Depot", owner: ada, projectId: null, layerCount: 1, layerColors: [], published: true,
  publishToken: "tok", updatedAt: AT, lastChangedAt: AT, lastChangedBy: ada,
} as unknown as MapOverview;
const flow = {
  id: "w", name: "Flow", owner: ada, origin: "workflow", projectId: null, updatedAt: AT, lastChangedAt: AT,
  lastChangedBy: ada, summary: { nodes: 1, sources: 0, liveOutputs: 0, status: "up_to_date", count: 0 }, steps: [],
} as unknown as WorkflowListing;

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

const keeps = cssRules("src/components/projects/ItemCards.module.css")
  .filter((r) => r.selector.includes("cardWhen") && /opacity:\s*1\s*;/.test(r.body));
const fades = cssRules("src/components/gallery.module.css")
  .filter((r) => r.selector.includes("cardWhen") && /opacity:\s*0\s*;/.test(r.body));

it.each(["hover", "focus-within"])("keeps a lone card's time under :%s, outranking the gallery's fade", async (state) => {
  await act(async () => {
    root.render(
      <SignedIn account={ada}>
        <MapCard map={depot} owner={null} />
        <WorkflowCard workflow={flow} lastRun={null} groupOf={() => null} owner={null} />
      </SignedIn>,
    );
  });
  const cards = container.querySelectorAll("article");
  expect(cards.map((c) => c.getAttribute("data-sec-card"))).toEqual(["map", "workflow"]);
  for (const card of cards) {
    const time = card.querySelectorAll("span").find((s) => s.className.includes("cardWhen"))!;
    const fade = fades.filter((r) => reachesInState(r, state, card, time));
    const keep = keeps.filter((r) => reachesInState(r, state, card, time));
    expect(fade.length).toBeGreaterThan(0);
    expect(keep.length, `a rule keeps the ${card.getAttribute("data-sec-card")} card's time`).toBeGreaterThan(0);
    for (const f of fade) {
      expect(keep.some((k) => outranks(specificity(k.selector), specificity(f.selector)))).toBe(true);
    }
  }
});
