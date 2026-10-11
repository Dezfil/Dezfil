import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateCard, TemplateList } from "@/lib/templates/card";
import type { TemplateTag } from "@/lib/templates/format";
import { HostEvent, installDomHost, type HostElement } from "../testing/dom-host";
import { TemplatesScreen } from "./TemplatesScreen";

/**
 * The Templates page's search box and tag chips over a fixture list of
 * five. Search narrows by title, question, place and credit; a chip by
 * tag, every tag a template carries counting, the two a card has room for
 * and the one it has not alike; the counts follow the search. Every
 * expected match and count below is stated from the fixture by hand,
 * never computed by the page's own code.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/theme", () => ({ useTheme: () => ({ theme: "light", toggle: vi.fn() }) }));

const card = (id: string, title: string, question: string, place: string, tags: TemplateTag[], credit: string, name: string): TemplateCard => ({
  id, kind: "map", version: 1, title, question, place, tags, dataDate: "2025",
  sources: [{ name, licence: "CC-BY-4.0", credit }],
  steps: null, origin: "shipped", installed: 1, listed: null, present: true, size: 1000, picture: "kept",
});

// Tags as stated: First map A; Time C, E; Analysis B; 3D A, D (D's third);
// Big data D; Widgets A (A's third), D. No template carries Flows.
const LIST: TemplateCard[] = [
  card("harbour", "Harbour depths", "Where is the water deep enough to berth?", "Hamburg", ["First map", "3D", "Widgets"], "Hamburg Port Authority", "Soundings"),
  card("reach", "Market reach", "Which blocks are furthest from a market?", "Leipzig", ["Analysis"], "Zensus 2022", "Census grid"),
  card("storms", "Storm tracks", "Where did the season's storms go?", "West Pacific", ["Time"], "NOAA NCEI", "IBTrACS"),
  card("trees", "Every tree in Berlin", "Which species, planted when?", "Berlin", ["Big data", "Widgets", "3D"], "Berlin tree register", "Baumbestand"),
  card("routes", "Air routes", "Which city pairs fly the most people?", "Europe", ["Time"], "Eurostat", "Air passenger transport"),
];

let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;

beforeEach(() => {
  const listed: TemplateList = {
    templates: LIST,
    catalogue: { state: "listed", host: null, folder: true, readAt: null, reason: null, status: null },
    downloads: { versions: 0, bytes: 0 },
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = String(input);
    if (url === "/api/templates" || url === "/api/templates/refresh") return Response.json(listed);
    if (url === "/api/operations") return Response.json({ operations: [] });
    return Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
  }));
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
function props(element: HostElement) {
  const key = Object.keys(element).find((name) => name.startsWith("__reactProps$"))!;
  return (element as unknown as Record<string, Record<string, (event: unknown) => void>>)[key];
}
const box = () => container.querySelector('input[aria-label="Search templates"]')!;
const search = async (text: string) => {
  await act(async () => props(box()).onChange({ target: { value: text } }));
  await settle();
};
const shown = () => container.querySelectorAll("article").map((a) => a.getAttribute("data-template"));
const chips = () => container.querySelector('[aria-label="Filter templates"]')!.querySelectorAll("button");
/** Each chip as its label and count, as the page draws them. */
const counts = () => chips().map((chip) => chip.textContent);
const pick = async (label: string) => {
  await act(async () => chips().find((chip) => chip.textContent.startsWith(`${label} ·`))!.click());
  await settle();
};
const empty = () => container.querySelector("[data-empty-line]")?.textContent ?? null;

describe("the tag chips", () => {
  it("count every tag a template carries, the ones its card has no room for included, and list only the tags carried", async () => {
    await open();
    expect(counts()).toEqual(["All · 5", "First map · 1", "Time · 2", "Analysis · 1", "3D · 2", "Big data · 1", "Widgets · 2"]);
    expect(chips().find((chip) => chip.hasAttribute("data-on"))?.textContent).toBe("All · 5");
  });

  it("narrow the grid to the templates carrying the tag, in the list's order", async () => {
    await open();
    await pick("Widgets");
    expect(shown()).toEqual(["harbour", "trees"]);
    expect(chips().find((chip) => chip.hasAttribute("data-on"))?.textContent).toBe("Widgets · 2");
    await pick("Time");
    expect(shown()).toEqual(["storms", "routes"]);
    await pick("All");
    expect(shown()).toEqual(["harbour", "reach", "storms", "trees", "routes"]);
  });
});

describe("the search box", () => {
  it.each([
    ["a title", "harbour", ["harbour"]],
    ["a question", "city pairs", ["routes"]],
    ["a place", "pacific", ["storms"]],
    ["a credit", "hamburg port", ["harbour"]],
    ["a source's name", "baumbestand", ["trees"]],
    ["any case", "BERLIN", ["trees"]],
    ["a word in two", "which", ["reach", "trees", "routes"]],
  ])("narrows by %s", async (_what, text, expected) => {
    await open();
    await search(text);
    expect(shown()).toEqual(expected);
  });

  it("is followed by the chips' counts, and keeps the chip picked", async () => {
    await open();
    await search("which");
    expect(counts()).toEqual(["All · 3", "First map · 0", "Time · 1", "Analysis · 1", "3D · 1", "Big data · 1", "Widgets · 1"]);
    await pick("Widgets");
    expect(shown()).toEqual(["trees"]);
    await search("");
    expect(shown()).toEqual(["harbour", "trees"]);
    expect(counts()[0]).toBe("All · 5");
  });

  it("says so in one line when nothing matches, and the chips count nothing", async () => {
    await open();
    expect(empty()).toBeNull();
    await search("lighthouse");
    expect(shown()).toEqual([]);
    expect(empty()).toBe("No template matches. Clear the search or pick All.");
    expect(counts()).toEqual(["All · 0", "First map · 0", "Time · 0", "Analysis · 0", "3D · 0", "Big data · 0", "Widgets · 0"]);
  });

  it("says the same when a chip and the search together match nothing", async () => {
    await open();
    await pick("Analysis");
    await search("berlin");
    expect(shown()).toEqual([]);
    expect(empty()).toBe("No template matches. Clear the search or pick All.");
  });

  it("takes the focus on /, never while typing in a field", async () => {
    await open();
    const press = async (target: HostElement) => {
      const event = Object.assign(new HostEvent("keydown", { bubbles: true, cancelable: true }), { key: "/" });
      await act(async () => { target.dispatchEvent(event); });
    };
    await press(host.document.body);
    expect(host.document.activeElement?.getAttribute("aria-label")).toBe("Search templates");
    const elsewhere = host.document.createElement("input");
    host.document.body.appendChild(elsewhere);
    elsewhere.focus();
    await press(elsewhere);
    expect(host.document.activeElement).toBe(elsewhere);
  });
});
