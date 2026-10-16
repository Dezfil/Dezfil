import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RefusedLayer, SearchResponse, ValueRow } from "@/lib/search/contract";
import { installDomHost, type HostElement } from "../../testing/dom-host";
import { SearchControl } from "./SearchControl";

/**
 * A layer whose matching values were refused answers no rows, so the
 * search says so in one quiet line under its results rather than letting
 * the layer drop out unseen; when the refusal is all there is, the line
 * takes the place of "No results.".
 */
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let slot: HostElement;
let answer: SearchResponse;

const refused = (layerName: string): RefusedLayer => ({
  layerId: `id-${layerName}`,
  layerName,
  error: "A value is larger than this query may return.",
  errorCode: "query_result_too_large",
});
const roadsRow: ValueRow = { layerId: "id-Roads", layerName: "Roads", field: "name", value: "Needle Street", point: [13.4, 52.5] };
const noPlaces = { state: "ok", attribution: null, results: [] } as const;

beforeEach(() => {
  answer = { layers: [], values: [], coordinates: [] };
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = String(input);
    if (url.startsWith("/api/maps/fixture/search?")) {
      return Response.json({ ...answer, ...(url.includes("places=1") ? { places: noPlaces } : {}) });
    }
    return Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
  }));
  host = installDomHost();
  slot = host.document.body.appendChild(host.document.createElement("div"));
  slot.setAttribute("id", "header-actions-start");
  root = createRoot(host.document.body.appendChild(host.document.createElement("div")) as unknown as Element);
});

afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
  vi.unstubAllGlobals();
});

async function settle(ms = 0) {
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
}
const field = () => slot.querySelectorAll("input")[0];
const props = (element: HostElement) =>
  (element as unknown as Record<string, Record<string, (event: unknown) => void>>)[Object.keys(element).find(name => name.startsWith("__reactProps$"))!];
/** The panel's notes under its result list, by their text. */
const notes = () => {
  const list = slot.querySelectorAll("ul").find(element => element.id === "search-results");
  const inList = new Set(list ? list.querySelectorAll("div") : []);
  return slot.querySelectorAll("div")
    .filter(element => !inList.has(element) && element.querySelectorAll("div").length === 0)
    .map(element => element.textContent);
};
const options = () => slot.querySelectorAll("li").filter(element => element.getAttribute("role") === "option");

async function type(query: string) {
  await act(async () => root.render(<SearchControl mapId="fixture" map={null} onAction={() => {}} />));
  await act(async () => props(field()).onChange({ target: { value: query } }));
}
/** Type and press Enter: the submitted search. */
async function submit(query: string) {
  await type(query);
  await act(async () => props(field()).onKeyDown({ key: "Enter", preventDefault() {} }));
  await settle();
}

describe("refused layers in the builder's search", () => {
  it("names a refused layer in place of No results when it is all there is", async () => {
    answer = { ...answer, refusedLayers: [refused("Parcels")] };
    await submit("needle");
    expect(options()).toHaveLength(0);
    expect(notes()).toEqual(["Values in Parcels are too large to search."]);
  });

  it("names several refused layers in one line under the other results", async () => {
    answer = { ...answer, values: [roadsRow], refusedLayers: [refused("Parcels"), refused("Zoning")] };
    await submit("needle");
    expect(options().map(option => option.textContent)).toEqual(["Needle StreetRoads"]);
    expect(notes()).toEqual(["Values in Parcels, Zoning are too large to search."]);
  });

  it("names a refused layer while typing, before any submit", async () => {
    answer = { ...answer, refusedLayers: [refused("Parcels")] };
    await type("needle");
    // Past the debounce the value round answers.
    await settle(120);
    expect(notes()).toEqual(["Values in Parcels are too large to search."]);
  });

  it("still says No results when nothing was refused", async () => {
    await submit("needle");
    expect(notes()).toEqual(["No results."]);
  });
});
