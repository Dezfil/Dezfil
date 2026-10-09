import { act } from "react";
import { createRoot } from "react-dom/client";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMetadataDb } from "@/lib/metadata/db";
import { OPERATIONS } from "@/lib/operations/catalog";
import { withAvailability } from "@/lib/operations/capability";
import { installDomHost, type HostElement } from "../../testing/dom-host";
import { expectSettingRemedy } from "../../../../test-support/setting-remedy";
import { SearchControl } from "./SearchControl";

/**
 * With no address finder, a submitted search's places line says what is
 * true now: an admin's setting while no variable locks it, the variable and
 * a restart while one does. The line takes that from the operations read,
 * which serves each verb's availability as the server words it; the read
 * here is the server's own answer for the instance under test.
 */
let dir: string;
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let slot: HostElement;
let operationsRead: number;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-search-remedy-"));
  vi.stubEnv("DEZFIL_DATA_DIR", path.join(dir, "data"));
  vi.stubEnv("DEZFIL_GEOCODER_URL", undefined);
  closeMetadataDb();
  operationsRead = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = String(input);
    if (url.startsWith("/api/maps/fixture/search?")) {
      return Response.json({ layers: [], values: [], coordinates: [], ...(url.includes("places=1") ? { places: { state: "unconfigured" } } : {}) });
    }
    if (url === "/api/operations") { operationsRead += 1; return Response.json({ operations: withAvailability(OPERATIONS) }); }
    return Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
  }));
  host = installDomHost();
  slot = host.document.body.appendChild(host.document.createElement("div"));
  slot.setAttribute("id", "header-actions-start");
  root = createRoot(host.document.body.appendChild(host.document.createElement("div")) as unknown as Element);
});

afterEach(async () => {
  act(() => root.unmount());
  host.uninstall();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  closeMetadataDb();
  await rm(dir, { recursive: true, force: true });
});

async function settle() {
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}
const field = () => slot.querySelectorAll("input")[0];
const props = (element: HostElement) =>
  (element as unknown as Record<string, Record<string, (event: unknown) => void>>)[Object.keys(element).find(name => name.startsWith("__reactProps$"))!];

/** Type a place and press Enter: the places-inclusive search. */
async function submitSearch(query: string): Promise<string> {
  await act(async () => root.render(<SearchControl mapId="fixture" map={null} onAction={() => {}} />));
  await act(async () => props(field()).onChange({ target: { value: query } }));
  await act(async () => props(field()).onKeyDown({ key: "Enter", preventDefault() {} }));
  await settle();
  const notes = slot.querySelectorAll("div")
    .filter(element => element.querySelectorAll("div").length === 0 && element.textContent.startsWith("Place search"));
  expect(notes).toHaveLength(1);
  return notes[0].textContent;
}

describe("the places line with no address finder", () => {
  it.each([false, true])("says what is true now (locked=%s)", async locked => {
    // A variable set to nothing locks the setting and still sets no address.
    if (locked) vi.stubEnv("DEZFIL_GEOCODER_URL", "  ");
    const line = await submitSearch("Alexanderplatz");
    expect(line).toMatch(/^Place search needs a geocoding endpoint\. /);
    expectSettingRemedy(line, "Address finder", "DEZFIL_GEOCODER_URL", locked);
    expect(operationsRead).toBe(1);
  });

  it("reads the operations only once a search has answered with no address finder", async () => {
    await act(async () => root.render(<SearchControl mapId="fixture" map={null} onAction={() => {}} />));
    await act(async () => props(field()).onChange({ target: { value: "Alexanderplatz" } }));
    await settle();
    expect(operationsRead).toBe(0);
  });

  it("still says what is missing when the operations cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string) => String(input).startsWith("/api/maps/fixture/search?")
      ? Response.json({ layers: [], values: [], coordinates: [], places: { state: "unconfigured" } })
      : Response.json({ error: { code: "internal", message: "Unavailable." } }, { status: 500 })));
    expect(await submitSearch("Alexanderplatz")).toBe("Place search needs a geocoding endpoint.");
  });
});
