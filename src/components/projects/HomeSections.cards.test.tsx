import { readdirSync } from "node:fs";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapOverview, TableListing } from "../api";
import { cssRules, outranks, reachesInState, specificity } from "../testing/css-rules";
import { HostEvent, installDomHost, type HostElement } from "../testing/dom-host";
import { SignedIn } from "../sharing/signed-in";
import type { WorkflowListing } from "../workflow-model";
import { HomeSections, type HomeView } from "./HomeSections";

/**
 * A project's cards as Bo reads them: his published map Depot, Ada's draft
 * map Survey, Ada's workflow Flow, his own workflow Mine and Ada's dataset
 * roads. Each card is a link named for its item that opens the item's page
 * by click or Enter; someone else's carries its owner's pill in the corner,
 * outside the link; a published map alone carries the published view's
 * link beside it; and every card keeps its time on hover and focus, where
 * the gallery would fade it.
 */

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));
vi.mock("../MapStrip", () => ({ MapStrip: () => null }));
vi.mock("../WorkflowThumb", () => ({ WorkflowThumb: () => null }));

const ada = { name: "Ada Okafor", sqlName: "ada" };
const bo = { name: "Bo Lindqvist", sqlName: "bo" };
const AT = "2026-10-02T14:00:00Z";
const map = (id: string, name: string, owner: typeof ada, publishToken: string | null) =>
  ({
    id, name, owner, projectId: "p", layerCount: 2, layerColors: [], published: publishToken !== null, publishToken,
    updatedAt: AT, lastChangedAt: AT, lastChangedBy: owner,
  }) as unknown as MapOverview;
const workflow = (id: string, name: string, owner: typeof ada) =>
  ({
    id, name, owner, origin: "workflow", projectId: "p", updatedAt: AT, lastChangedAt: AT, lastChangedBy: owner,
    summary: { nodes: 2, sources: 1, liveOutputs: 0, status: "up_to_date", count: 0 }, steps: [],
  }) as unknown as WorkflowListing;
const roads = {
  id: "t-ada", name: "roads", qualifiedName: "ada.roads", owner: ada, projectIds: ["p"], rowCount: 3, sizeBytes: 2048,
  geometryColumn: "geom", geometryType: "LINESTRING", importedAt: AT, createdAt: AT,
} as unknown as TableListing;

const MAPS = [map("m-bo", "Depot", bo, "tok-depot"), map("m-ada", "Survey", ada, null)];
const WORKFLOWS = [workflow("w-ada", "Flow", ada), workflow("w-bo", "Mine", bo)];

let host: ReturnType<typeof installDomHost>;
let container: HostElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  host = installDomHost();
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
  nav.push.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
});

const mount = (view: HomeView) => act(async () => {
  root.render(
    <SignedIn account={bo}>
      <HomeSections
        projectId="p" maps={MAPS} workflows={WORKFLOWS} tables={[roads]} names={new Map()}
        lastRuns={new Map([["w-ada", "unreadable"]])} view={view} groupOf={() => null}
      />
    </SignedIn>,
  );
});
const cards = () => container.querySelectorAll("[data-sec-card]");
const card = (name: string) => cards().find((c) => c.querySelector(`[aria-label="Open ${name}"]`))!;
const press = (el: HostElement, key: string) =>
  act(async () => { el.dispatchEvent(Object.assign(new HostEvent("keydown", { bubbles: true, cancelable: true }), { key })); });

describe("a project's map and workflow cards", () => {
  it("are links named for their item that open its page on a click or on Enter", async () => {
    await mount("cards");
    const links = container.querySelectorAll('[role="link"]');
    expect(links.map((l) => l.getAttribute("aria-label"))).toEqual(["Open Depot", "Open Survey", "Open Flow", "Open Mine", "Open roads"]);
    expect(links.map((l) => l.getAttribute("tabindex"))).toEqual(["0", "0", "0", "0", "0"]);
    expect(card("Survey").querySelector('[title="Survey"]')?.textContent).toBe("Survey");
    await act(async () => links[1].click());
    expect(nav.push).toHaveBeenLastCalledWith("/maps/m-ada");
    await press(links[2], "Enter");
    expect(nav.push).toHaveBeenLastCalledWith("/workflows/w-ada");
    await press(links[3], " ");
    await press(links[3], "Tab");
    expect(nav.push).toHaveBeenCalledTimes(2);
  });

  it("mark someone else's item with its owner's pill in the corner, outside the link, and one's own with none", async () => {
    await mount("cards");
    const pills = cards().map((c) => c.querySelector("[data-owner-pill]"));
    expect(pills.map((p) => p?.getAttribute("data-owner-pill") ?? null)).toEqual([null, "ada", "ada", null, "ada"]);
    for (const pill of pills.filter((p) => p !== null)) {
      expect(pill!.getAttribute("data-placement")).toBe("corner");
      expect(pill!.getAttribute("aria-label")).toBe("Shared by Ada Okafor");
      expect(pill!.closest('[role="link"]')).toBeNull();
    }
    expect(card("Survey").querySelector('[role="link"]')?.getAttribute("aria-label")).toBe("Open Survey");
  });

  it("say a workflow's unreadable run history on its chip", async () => {
    await mount("cards");
    expect(card("Flow").querySelector('[title="The run history couldn\'t be read"]')).not.toBeNull();
    expect(card("Mine").querySelector('[title="The run history couldn\'t be read"]')).toBeNull();
  });
});

describe.each(["cards", "list"] as const)("the published view's link (%s)", (view) => {
  it("stands beside a published map alone, opens the view in a new tab and opens nothing else", async () => {
    await mount(view);
    const anchors = container.querySelectorAll("a").filter((a) => a.getAttribute("href")?.startsWith("/v/"));
    expect(anchors).toHaveLength(1);
    const [link] = anchors;
    expect(link.getAttribute("href")).toBe("/v/tok-depot");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer");
    expect(link.getAttribute("aria-label")).toBe("Open the published view of Depot");
    expect(link.getAttribute("data-hint")).toBe("Open the published view");
    expect(link.closest('[role="link"]')).toBeNull();
    expect(link.closest("button")).toBeNull();
    await act(async () => link.click());
    expect(nav.push).not.toHaveBeenCalled();
  });
});

describe("a card's time on hover", () => {
  const keeps = readdirSync("src/components/projects")
    .filter((f) => f.endsWith(".module.css"))
    .flatMap((f) => cssRules(`src/components/projects/${f}`))
    .filter((r) => r.selector.includes("cardWhen") && /opacity:\s*1\s*;/.test(r.body));
  const fades = cssRules("src/components/gallery.module.css")
    .filter((r) => r.selector.includes("cardWhen") && /opacity:\s*0\s*;/.test(r.body));

  it.each(["hover", "focus-within"])("stays on every card under :%s, outranking the gallery's fade", async (state) => {
    await mount("cards");
    expect(cards()).toHaveLength(5);
    for (const c of cards()) {
      const time = c.querySelectorAll("span").find((s) => s.className.includes("cardWhen"))!;
      expect(time).toBeDefined();
      const fade = fades.filter((r) => reachesInState(r, state, c, time));
      const keep = keeps.filter((r) => reachesInState(r, state, c, time));
      expect(fade.length, `the gallery fades ${c.getAttribute("data-sec-card")}`).toBeGreaterThan(0);
      expect(keep.length, `a rule keeps ${c.getAttribute("data-sec-card")}'s time`).toBeGreaterThan(0);
      for (const f of fade) {
        expect(keep.some((k) => outranks(specificity(k.selector), specificity(f.selector))), `${keep[0].selector} over ${f.selector}`).toBe(true);
      }
    }
  });
});
