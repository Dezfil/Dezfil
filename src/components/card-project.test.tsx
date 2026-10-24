import { createHash } from "node:crypto";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapOverview } from "./api";
import { IconFolder } from "./gallery-icons";
import { MapsScreen } from "./MapsScreen";
import { WorkflowsScreen } from "./WorkflowsScreen";
import { SignedIn } from "./sharing/signed-in";
import { cssRules } from "./testing/css-rules";
import { installDomHost, type HostElement } from "./testing/dom-host";
import type { WorkflowListing } from "./workflow-model";

/**
 * The project a map or workflow card is in, on the card's footer: the
 * status pill, then the folder glyph the page's project filter carries,
 * then the project's name, read aloud as "Project: <name>". A card in no
 * project says nothing there. The pill's label and the name share one text
 * line: the footer is centred and never wraps, and a long name truncates.
 * The suite computes no layout, so those rules are read back from the
 * stylesheet the footer's classes come from.
 */

const lists = vi.hoisted(() => ({ world: null as unknown }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/theme", () => ({ useTheme: () => ({ theme: "light" }) }));
vi.mock("./builder/drawer/use-operations", () => ({ useOperations: () => ({ operations: [] }) }));
vi.mock("./use-view-prefs", async (original) => ({
  ...(await original<typeof import("./use-view-prefs")>()),
  useViewPrefs: () => ({ view: "grid", sort: "edited", settled: true, setView: vi.fn(), setSort: vi.fn() }),
}));
vi.mock("./scope/use-scope", () => ({ useProjectScope: () => ({ scope: { kind: "all" }, setScope: vi.fn() }) }));
vi.mock("./scope/use-scope-world", () => ({
  useScopeWorld: () => ({ state: { status: "ready", value: lists.world }, retry: vi.fn(), mutate: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("./MapStrip", () => ({ MapStrip: () => null }));
vi.mock("./WorkflowThumb", () => ({ WorkflowThumb: () => <i data-graph="" /> }));
vi.mock("./gallery-icons", async (original) => ({ ...await original<object>(), MapPlaceholder: () => <i data-placeholder="" /> }));

const bo = { name: "Bo Lindqvist", sqlName: "bo" };
const projects = [{ id: "berlin", name: "Berlin housing study" }];

const map = (id: string, name: string, projectId: string | null): MapOverview =>
  ({
    id, name, viewport: { lng: 0, lat: 0, zoom: 2 }, basemap: null, customBasemap: null, basemapLayers: null,
    note: null, legendCorner: null, legendOrder: null, timeline: null, widgets: [], widgetsPublished: false,
    publishToken: `token-${id}`, publishedAt: "2026-09-01T00:00:00Z", published: true,
    createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z", editRevision: "r1",
    projectId, owner: bo, home: bo.sqlName, layerCount: 1, layerColors: [],
  }) as unknown as MapOverview;

const workflow = (id: string, name: string, projectId: string | null): WorkflowListing =>
  ({
    id, name, origin: "workflow", projectId, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z",
    summary: { status: "never_run", count: 0, nodes: 1, sources: 0, liveOutputs: 0 }, steps: [], owner: bo, home: bo.sqlName,
  }) as unknown as WorkflowListing;

/** The folder glyph's own outline, as the gallery's icon set draws it. */
const FOLDER = /<path d="([^"]+)"/.exec(renderToStaticMarkup(<IconFolder />))![1];

const GALLERY = "src/components/gallery.module.css";
const GALLERY_HASH = createHash("sha1").update(GALLERY).digest("hex").slice(0, 6);

/** What the gallery stylesheet declares for an element's own classes, on
 * the rule `.<class><suffix>`, the later declaration winning. */
function declared(el: HostElement, suffix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const cls of el.className.split(/\s+/)) {
    const m = /^_(.+)_([0-9a-f]{6})$/.exec(cls);
    if (!m || m[2] !== GALLERY_HASH) continue;
    for (const rule of cssRules(GALLERY).filter((r) => r.selector === `.${m[1]}${suffix}`)) {
      for (const [, prop, value] of rule.body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) out.set(prop, value.trim());
    }
  }
  return out;
}

let host: ReturnType<typeof installDomHost>;
let container: HostElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 })));
  host = installDomHost();
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
  vi.unstubAllGlobals();
});

async function open(screen: React.ReactNode) {
  await act(async () => root.render(<SignedIn account={bo}>{screen}</SignedIn>));
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

/** A card's face, and the line under its name: the footer. */
function cardOf(name: string): { face: HostElement; footer: HostElement } {
  const face = container.querySelector(`[aria-label="Open ${name}"]`);
  expect(face, `${name}'s card is drawn`).toBeTruthy();
  const top = face!.querySelectorAll("div").find((d) => /_cardTop_/.test(d.className))!;
  const lines = top.parentElement!.children;
  return { face: face!, footer: lines[lines.indexOf(top) + 1] };
}

const screens = [
  {
    page: "Maps",
    counted: true,
    filed: "Station catchments",
    loose: "Berth occupancy",
    gone: "Quay survey",
    render: () => {
      lists.world = {
        projects, all: [],
        scoped: [map("m1", "Station catchments", "berlin"), map("m2", "Berth occupancy", null), map("m3", "Quay survey", "gone")],
      };
      return <MapsScreen />;
    },
  },
  {
    page: "Workflows",
    counted: false,
    filed: "Vessel density",
    loose: "Port calls",
    gone: "Ferry routes",
    render: () => {
      lists.world = {
        projects, all: [],
        scoped: [workflow("w1", "Vessel density", "berlin"), workflow("w2", "Port calls", null), workflow("w3", "Ferry routes", "gone")],
      };
      return <WorkflowsScreen />;
    },
  },
];

describe("the Maps page's layer count", () => {
  it("stands in the card's body after the status pill, with the layers' colour dots, and nothing over the picture says it; the owner's pill and the quick actions stay on the card", async () => {
    lists.world = {
      projects, all: [],
      scoped: [
        { ...map("m1", "Station catchments", "berlin"), layerCount: 2, layerColors: ["rgb(1, 2, 3)", "rgb(4, 5, 6)"], owner: { name: "Ada Okafor", sqlName: "ada" } },
        { ...map("m2", "Berth occupancy", null), layerCount: 1, layerColors: ["rgb(7, 8, 9)"] },
        { ...map("m3", "Quay survey", null), layerCount: 0, layerColors: [] },
      ],
    };
    await open(<MapsScreen />);
    for (const [name, words, dots] of [
      ["Station catchments", "2 layers", ["rgb(1, 2, 3)", "rgb(4, 5, 6)"]],
      ["Berth occupancy", "1 layer", ["rgb(7, 8, 9)"]],
      ["Quay survey", "0 layers", []],
    ] as const) {
      const { face, footer } = cardOf(name);
      const count = footer.children[1];
      expect(count.hasAttribute("data-layer-count"), `${name}: the count follows the pill`).toBe(true);
      expect(count.textContent).toBe(words);
      expect(count.querySelectorAll("i").map((dot) => dot.style.getPropertyValue("background"))).toEqual(dots);
      expect(face.querySelectorAll("[data-layer-count]"), `${name}: one count, in the body`).toHaveLength(1);
      const strip = face.children[0];
      expect(strip.textContent, `${name}: nothing over the picture`).toBe("");
    }
    const card = cardOf("Station catchments").face.parentElement!;
    expect(card.children.some((child) => child.hasAttribute("data-owner-pill")), "the owner's pill on the card").toBe(true);
    const duplicate = card.querySelector('[aria-label="Duplicate Station catchments"]');
    expect(duplicate?.parentElement?.parentElement, "the quick actions on the card, off its link").toBe(card);
  });
});

describe.each(screens.map((s) => [s.page, s] as const))("the %s page's card footer", (_page, { counted, filed, loose, gone, render }) => {
  /** The footer's parts: the status pill, a map's layer count, then the project. */
  const parts = (footer: HostElement) => {
    const [pill, ...rest] = footer.children;
    const count = counted ? rest.shift() : undefined;
    if (counted) expect(count?.hasAttribute("data-layer-count"), "a map's layer count follows the pill").toBe(true);
    return { pill, count, rest };
  };

  it("follows the status pill (and a map's layer count) with the folder glyph and the project's name, read as one phrase", async () => {
    await open(render());
    const { footer } = cardOf(filed);
    expect(footer.children, "the pill, a map's count, then the project").toHaveLength(counted ? 3 : 2);
    const { pill, rest: [tag] } = parts(footer);
    expect(pill.querySelector("i"), "the status pill leads").toBeTruthy();
    expect(tag.getAttribute("role")).toBe("img");
    expect(tag.getAttribute("aria-label")).toBe("Project: Berlin housing study");
    expect(tag.textContent).toBe("Berlin housing study");
    expect(tag.querySelector("path")?.getAttribute("d"), "the page's folder glyph").toBe(FOLDER);
  });

  it("says nothing for work in no project", async () => {
    await open(render());
    const { face, footer } = cardOf(loose);
    expect(footer.children, "the status pill alone, with a map's count").toHaveLength(counted ? 2 : 1);
    parts(footer);
    expect(face.textContent).not.toContain("not in a project");
    expect(face.querySelectorAll("path").some((p) => p.getAttribute("d") === FOLDER)).toBe(false);
  });

  it("keeps the glyph for a project the reader no longer reaches, said without its name", async () => {
    await open(render());
    const { rest: [tag] } = parts(cardOf(gone).footer);
    expect(tag.getAttribute("aria-label")).toBe("Project: a project you no longer reach");
    expect(tag.textContent).toBe("a project you no longer reach");
    expect(tag.querySelector("path")?.getAttribute("d")).toBe(FOLDER);
  });

  it("sets the name on the pill's text line, one line only, the glyph 8px after the pill (or a map's count) and the name 5px after it", async () => {
    await open(render());
    const { pill, count, rest: [tag] } = parts(cardOf(filed).footer);
    const name = tag.querySelector("span")!;
    const line = declared(tag.parentElement!);
    // Centred, the pill's label and the name share a line, both the meta size.
    expect(line.get("display")).toBe("flex");
    expect(line.get("align-items")).toBe("center");
    expect(line.get("flex-wrap") ?? "nowrap").toBe("nowrap");
    expect(declared(tag).get("font-size")).toBe(declared(pill).get("font-size"));
    // A long name truncates on that line rather than pushing or wrapping.
    expect(declared(tag).get("min-width")).toBe("0");
    expect(declared(name)).toEqual(new Map([["overflow", "hidden"], ["text-overflow", "ellipsis"], ["white-space", "nowrap"]]));
    // The glyph: 13px in the faint ink; the name in the muted ink.
    expect(declared(tag, " svg").get("width")).toBe("13px");
    expect(declared(tag, " svg").get("color")).toBe("var(--fg-faint)");
    expect(declared(tag).get("color")).toBe("var(--fg-muted)");
    // 8px from the pill to the glyph, 5px from the glyph to the name.
    expect(parseFloat(line.get("gap")!) + parseFloat(declared(tag).get("margin-left")!)).toBe(8);
    expect(declared(tag).get("gap")).toBe("5px");
    if (count) {
      // A map's count stands as the project does: 8px after the pill, on its line, the meta size.
      expect(parseFloat(line.get("gap")!) + parseFloat(declared(count).get("margin-left")!)).toBe(8);
      expect(declared(count).get("font-size")).toBe(declared(pill).get("font-size"));
      expect(declared(count).get("white-space")).toBe("nowrap");
    }
  });
});
