import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogueState, TemplateCard, TemplateList } from "@/lib/templates/card";
import { installDomHost, type HostElement } from "../testing/dom-host";
import { TemplatesScreen } from "./TemplatesScreen";

/**
 * The Templates page over a fixture list: one card per template in the
 * list's order, every field a card draws, a workflow example's graph and
 * tools line, the catalogue's one line per state, and the page drawn from
 * the list before the catalogue's refresh answers. The list, the refresh
 * and the operation catalog are fakes answering through fetch; the
 * expected words are written here, never read from the module under test.
 */

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: nav.push, replace: vi.fn() }) }));
vi.mock("@/components/theme", () => ({ useTheme: () => ({ theme: "light", toggle: vi.fn() }) }));

const source = (name: string, licence: string, credit: string) => ({ name, licence, credit });

const harbour: TemplateCard = {
  id: "harbour-depths", kind: "map", version: 2, title: "Harbour depths",
  question: "Where is the water deep enough to berth?", place: "Hamburg",
  tags: ["First map", "3D", "Widgets"], dataDate: "2026-10",
  sources: [source("Soundings", "CC-BY-4.0", "Hamburg Port Authority"), source("OpenStreetMap", "ODbL-1.0", "© OpenStreetMap contributors")],
  steps: null, origin: "shipped", installed: 2, listed: null, present: true, size: 3_200_000, picture: "kept",
};
const reach: TemplateCard = {
  id: "market-reach", kind: "workflow", version: 4, title: "Market reach",
  question: "Which blocks are furthest from a market?", place: "Leipzig",
  tags: ["Analysis"], dataDate: "2025",
  sources: [source("Census grid", "dl-de-by-2.0", "Zensus 2022")],
  steps: [
    { id: "near", operation: "nearest", output: "block_nearest", reads: ["blocks", "markets"] },
    { id: "sum", operation: "summarize", output: "reach_by_district", reads: ["block_nearest", "districts"] },
  ],
  origin: "catalogue", installed: null, listed: 4, present: false, size: 6 * 1024 * 1024, picture: "not_kept",
};
const storms: TemplateCard = {
  id: "storm-tracks", kind: "map", version: 1, title: "Storm tracks",
  question: "Where did the season's storms go?", place: "West Pacific",
  tags: ["Time"], dataDate: "2024-08-29",
  sources: [source("IBTrACS", "CC0-1.0", "NOAA NCEI")],
  steps: null, origin: "catalogue", installed: 1, listed: 1, present: true, size: 900_000, picture: "kept",
};

const catalogue = (state: CatalogueState["state"], more: Partial<CatalogueState> = {}): CatalogueState =>
  ({ state, host: "https://catalogue.test", folder: false, readAt: null, reason: null, status: null, ...more });
const list = (templates: TemplateCard[], state: CatalogueState): TemplateList =>
  ({ templates, catalogue: state, downloads: { versions: 0, bytes: 0 } });

const OPERATIONS = [
  { id: "nearest", group: "Join", label: "Nearest" },
  { id: "summarize", group: "Summarize", label: "Summarize" },
];

let listed: TemplateList;
let refreshAnswer: () => Promise<Response>;
let fetchSpy: ReturnType<typeof vi.fn>;
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;

beforeEach(() => {
  nav.push.mockReset();
  listed = list([harbour, reach, storms], catalogue("listed"));
  refreshAnswer = async () => Response.json(listed);
  fetchSpy = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/templates" && (init?.method ?? "GET") === "GET") return Response.json(listed);
    if (url === "/api/templates/refresh" && init?.method === "POST") return refreshAnswer();
    if (url === "/api/operations") return Response.json({ operations: OPERATIONS });
    return Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchSpy);
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

async function settle() {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function open() {
  await act(async () => root.render(<TemplatesScreen />));
  await settle();
}
const cards = () => container.querySelectorAll("article").filter((card) => card.hasAttribute("data-template"));
const card = (id: string) => cards().find((c) => c.getAttribute("data-template") === id)!;
const field = (c: HostElement, name: string) => c.querySelector(`[data-field="${name}"]`);
const line = () => container.querySelector("[data-catalogue-line]")?.textContent ?? null;
const refreshCalls = () => fetchSpy.mock.calls.filter(([url]) => String(url) === "/api/templates/refresh");

describe("the Templates page's cards", () => {
  it("draws one card per template in the list's order, shipped first as the list gives them", async () => {
    await open();
    expect(cards().map((c) => c.getAttribute("data-template"))).toEqual(["harbour-depths", "market-reach", "storm-tracks"]);
    expect(container.querySelector("h1")?.textContent).toBe("Templates");
  });

  it("draws every field of a map template's card", async () => {
    await open();
    const c = card("harbour-depths");
    const img = c.querySelector("img");
    expect(img?.getAttribute("src")).toBe("/api/templates/harbour-depths/picture?v=2&theme=light");
    expect(field(c, "place")?.textContent).toBe("Hamburg");
    expect(field(c, "title")?.textContent).toBe("Harbour depths");
    expect(field(c, "date")?.textContent).toBe("Oct 2026");
    expect(field(c, "date")?.getAttribute("data-hint")).toBe("Data of Oct 2026");
    expect(field(c, "question")?.textContent).toBe("Where is the water deep enough to berth?");
    expect(field(c, "tags")?.querySelectorAll("span").map((tag) => tag.textContent)).toEqual(["First map", "3D"]);
    expect(field(c, "credit")?.textContent).toBe("Hamburg Port Authority · © OpenStreetMap contributors");
    expect(field(c, "credit")?.getAttribute("data-hint")).toBe("Hamburg Port Authority (CC-BY-4.0) · © OpenStreetMap contributors (ODbL-1.0)");
    expect(field(c, "absent")).toBeNull();
    expect(field(c, "tools")).toBeNull();
    expect(c.querySelector('button[aria-label="Open Harbour depths"]')).not.toBeNull();
    expect(c.querySelector('button[aria-label="Make a copy of Harbour depths"]')).not.toBeNull();
  });

  it("lets the date's and the credit's hints show, their words marked as not explaining them", async () => {
    // The hint layer shows no bubble over visible words unless they are
    // marked: the date alone does not say it is the data's, and the credit
    // line is cut short with its licences left out.
    await open();
    const c = card("harbour-depths");
    for (const name of ["date", "credit"]) {
      const hinted = field(c, name)!;
      const words = hinted.querySelector("[data-hint-ignore-text]");
      expect(words?.textContent, name).toBe(hinted.textContent);
      expect(hinted.childNodes, name).toHaveLength(1);
    }
  });

  it("draws a day's date as a day and a downloaded map's picture from its own version", async () => {
    await open();
    const c = card("storm-tracks");
    expect(field(c, "date")?.textContent).toBe("29 Aug 2024");
    expect(c.querySelector("img")?.getAttribute("src")).toBe("/api/templates/storm-tracks/picture?v=1&theme=light");
  });

  it("draws a workflow example's graph as its picture, its tools on a line of their own, and an absent version's size", async () => {
    await open();
    const c = card("market-reach");
    // The graph: two steps as nodes, the three template datasets they read as sources.
    expect(c.querySelectorAll('rect[data-kind="node"]')).toHaveLength(2);
    expect(c.querySelectorAll('rect[data-kind="source"]')).toHaveLength(3);
    expect(c.querySelector("img")).toBeNull();
    expect(field(c, "tools")?.textContent).toBe("Nearest · Summarize");
    expect(field(c, "tags")?.textContent).toBe("Analysis");
    expect(field(c, "tags")?.textContent).not.toContain("Nearest");
    expect(field(c, "date")?.textContent).toBe("2025");
    expect(field(c, "absent")?.textContent).toBe("Downloads 6.0 MB when opened");
    expect(field(c, "credit")?.textContent).toBe("Zensus 2022");
  });

  it("draws a map whose picture the server does not hold on the placeholder, asking for no picture", async () => {
    listed = list([{ ...harbour, picture: "not_kept" }], catalogue("listed"));
    await open();
    expect(card("harbour-depths").querySelector("img")).toBeNull();
    expect(card("harbour-depths").querySelector("svg")).not.toBeNull();
  });

  it("opens a template at its own address", async () => {
    await open();
    await act(async () => { card("storm-tracks").querySelector('[role="link"]')!.click(); });
    expect(nav.push).toHaveBeenLastCalledWith("/templates/storm-tracks");
    await act(async () => { card("harbour-depths").querySelector('button[aria-label="Open Harbour depths"]')!.click(); });
    expect(nav.push).toHaveBeenLastCalledWith("/templates/harbour-depths");
  });

  it("makes a copy from a card through the copy dialog, which reads the template once as it opens", async () => {
    const howMade = { question: "Which blocks?", datasets: [{ dataset: "blocks", source: "Census grid", made: "Blocks." }], styling: ["Blocks."] };
    const base = fetchSpy.getMockImplementation() as (input: string, init?: RequestInit) => Promise<Response>;
    fetchSpy.mockImplementation(async (input: string, init?: RequestInit) =>
      String(input) === "/api/templates/market-reach" ? Response.json({ ...reach, howMade }) : base(input, init));
    await open();
    await act(async () => { card("market-reach").querySelector('button[aria-label="Make a copy of Market reach"]')!.click(); });
    await settle();
    const dialog = host.document.querySelector("[data-template-copy-dialog]");
    expect(dialog?.querySelector("[data-copy-sub]")?.textContent).toBe("Market reach, version 4, becomes yours in a new project.");
    expect(fetchSpy.mock.calls.filter(([url]) => String(url) === "/api/templates/market-reach")).toHaveLength(1);
    expect(nav.push).not.toHaveBeenCalled();
    await act(async () => { dialog!.querySelectorAll("button").find((b) => b.textContent === "Cancel")!.click(); });
    expect(host.document.querySelector("[data-template-copy-dialog]")).toBeNull();
  });
});

describe("the catalogue's line", () => {
  const ONLY = "so only the templates on this server show.";
  const cases: [string, CatalogueState, string | null][] = [
    ["listed", catalogue("listed"), null],
    ["off", catalogue("off"), `The template catalogue is turned off, ${ONLY}`],
    ["unreachable", catalogue("unreachable"), `The template catalogue did not answer, ${ONLY}`],
    ["slow", catalogue("slow"), `The template catalogue did not answer in time, ${ONLY}`],
    ["empty", catalogue("empty"), `The template catalogue lists no templates, ${ONLY}`],
    ["refused by a status", catalogue("refused", { reason: "status", status: 404 }), `The template catalogue answered with status 404, ${ONLY}`],
    ["refused by the egress rules", catalogue("refused", { reason: "egress_blocked" }), `This server's network rules block the template catalogue, ${ONLY}`],
    ["refused for an unreadable address", catalogue("refused", { reason: "service_address_unreadable", host: null }), `The template catalogue's saved address can no longer be read, ${ONLY}`],
    ["refused for a list too large", catalogue("refused", { reason: "template_index_too_large" }), `The template catalogue's list is too large to read, ${ONLY}`],
    ["refused for a list it does not read", catalogue("refused", { reason: "template_index_invalid" }), `The template catalogue's list could not be read, ${ONLY}`],
    ["refused for an id twice", catalogue("refused", { reason: "template_index_repeats_id" }), `The template catalogue's list names one template twice, ${ONLY}`],
    ["refused for an address outside", catalogue("refused", { reason: "template_address_outside" }), `The template catalogue's list points outside the catalogue, ${ONLY}`],
  ];

  it.each(cases)("says why when the catalogue is %s, the shipped and downloaded cards drawn", async (_label, state, expected) => {
    listed = list([harbour, storms], state);
    await open();
    expect(line()).toBe(expected);
    expect(cards().map((c) => c.getAttribute("data-template"))).toEqual(["harbour-depths", "storm-tracks"]);
  });

  it("asks for no refresh while the catalogue is off or its address cannot be read, and one otherwise", async () => {
    listed = list([harbour], catalogue("off"));
    await open();
    expect(refreshCalls()).toHaveLength(0);
    act(() => root.unmount());
    root = createRoot(container as unknown as Element);
    listed = list([harbour], catalogue("refused", { reason: "service_address_unreadable", host: null }));
    await open();
    expect(refreshCalls()).toHaveLength(0);
    act(() => root.unmount());
    root = createRoot(container as unknown as Element);
    listed = list([harbour], catalogue("unreachable"));
    await open();
    expect(refreshCalls()).toHaveLength(1);
  });

  it("never names the catalogue's address in its line", async () => {
    listed = list([harbour], catalogue("refused", { reason: "status", status: 503, host: "https://catalogue.test" }));
    await open();
    expect(line()).not.toContain("catalogue.test");
  });
});

describe("the page and the catalogue's refresh", () => {
  it("draws the list's cards before the refresh answers, then the refreshed list", async () => {
    listed = list([harbour], catalogue("not_read"));
    let release: (response: Response) => void = () => {};
    refreshAnswer = () => new Promise((resolve) => { release = resolve; });
    await open();
    // The refresh is asked for and has not answered: the page is drawn anyway.
    expect(refreshCalls()).toHaveLength(1);
    expect(cards().map((c) => c.getAttribute("data-template"))).toEqual(["harbour-depths"]);
    expect(line()).toBe("Reading the template catalogue…");
    await act(async () => release(Response.json(list([harbour, reach], catalogue("listed")))));
    await settle();
    expect(cards().map((c) => c.getAttribute("data-template"))).toEqual(["harbour-depths", "market-reach"]);
    expect(line()).toBeNull();
  });

  it("keeps the list's cards and says the server's sentence when the refresh is refused", async () => {
    listed = list([harbour], catalogue("not_read"));
    refreshAnswer = async () => Response.json(
      { error: { code: "templates_catalogue_off", message: "The template catalogue is turned off on this instance." } }, { status: 409 });
    await open();
    expect(cards().map((c) => c.getAttribute("data-template"))).toEqual(["harbour-depths"]);
    expect(line()).toBe("The template catalogue is turned off on this instance.");
  });

  it("says the list's own failure and offers a retry", async () => {
    let fail = true;
    fetchSpy.mockImplementation(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/templates" && (init?.method ?? "GET") === "GET") {
        return fail
          ? Response.json({ error: { code: "internal", message: "The templates could not be read." } }, { status: 500 })
          : Response.json(listed);
      }
      if (url === "/api/templates/refresh") return Response.json(listed);
      if (url === "/api/operations") return Response.json({ operations: OPERATIONS });
      return Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
    });
    await open();
    expect(container.textContent).toContain("The templates could not be read.");
    expect(cards()).toHaveLength(0);
    expect(refreshCalls()).toHaveLength(0);
    fail = false;
    const retry = container.querySelectorAll("button").find((b) => b.textContent === "Try again")!;
    await act(async () => retry.click());
    await settle();
    expect(cards()).toHaveLength(3);
  });
});
