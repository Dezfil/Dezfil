import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BASEMAPS, SATELLITE_STYLE_URL } from "@/lib/basemap";
import type { MapOverview } from "./api";
import { installDomHost, type HostElement } from "./testing/dom-host";
import { MapsScreen } from "./MapsScreen";
import { SignedIn } from "./sharing/signed-in";

/**
 * The Maps gallery credits the basemaps its pictures were drawn on with
 * one line for the page: in the grid under the scroller, so it stands
 * whatever the scroll, and in the list as the list card's foot row. A page
 * whose maps all show chart paper carries none. The list's world and the
 * view preference are fakes; the instance's styles are handed in as the
 * page hands them.
 */

const lists = vi.hoisted(() => ({ world: null as unknown, view: "grid" as "grid" | "list" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
// The line's one link is a plain anchor here, standing in for next/link's.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock("@/components/theme", () => ({ useTheme: () => ({ theme: "light" }) }));
vi.mock("./MapStrip", () => ({ MapStrip: () => null }));
vi.mock("./use-view-prefs", async (original) => ({
  ...(await original<typeof import("./use-view-prefs")>()),
  useViewPrefs: () => ({ view: lists.view, sort: "edited", settled: true, setView: vi.fn(), setSort: vi.fn() }),
}));
vi.mock("./scope/use-scope", () => ({ useProjectScope: () => ({ scope: { kind: "all" }, setScope: vi.fn() }) }));
vi.mock("./scope/use-scope-world", () => ({
  useScopeWorld: () => ({ state: { status: "ready", value: lists.world }, retry: vi.fn(), mutate: vi.fn(), refresh: vi.fn() }),
}));

const bo = { name: "Bo Lindqvist", sqlName: "bo" };
const SATELLITE = { key: "satellite" as const, label: "Satellite", url: SATELLITE_STYLE_URL, kind: "imagery" as const, attribution: [{ label: "© Imagery Provider" }] };
const INSTANCE = { basemaps: [...BASEMAPS, SATELLITE], defaultUrl: BASEMAPS[0].url, overrideUrl: null, overrideAttribution: [] };

const map = (id: string, basemap: MapOverview["basemap"], hasThumbnail = true): MapOverview =>
  ({
    id, name: `Map ${id}`, viewport: { lng: 0, lat: 0, zoom: 2 }, basemap, customBasemap: null, basemapLayers: null,
    published: false, publishToken: null, publishedAt: null, hasThumbnail,
    createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z", editRevision: "r1",
    projectId: null, owner: bo, home: bo.sqlName, layerCount: 1, layerColors: [],
  }) as unknown as MapOverview;

let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;
beforeEach(() => {
  lists.view = "grid";
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

async function open(maps: MapOverview[], rendererNotice?: boolean) {
  lists.world = { projects: [], all: maps, scoped: maps };
  await act(async () => root.render(<SignedIn account={bo}><MapsScreen pictureBasemaps={INSTANCE} rendererNotice={rendererNotice} /></SignedIn>));
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
const credits = () => container.querySelectorAll("[data-picture-credit]");
const links = (el: HostElement) => el.querySelectorAll("a").map((a) => [a.textContent, a.getAttribute("href")]);
const screen = () => container.childNodes[0] as HostElement;

describe("the Maps gallery's line for its pictures", () => {
  it("stands under the grid's scroller, the screen's last row, and names the built-in credit as two links", async () => {
    await open([map("a", null), map("b", "dark")]);
    expect(credits()).toHaveLength(1);
    const [line] = credits();
    expect(line.dataset.pictureCredit).toBe("page");
    expect(line.parentElement).toBe(screen());
    expect(screen().childNodes.at(-1)).toBe(line);
    // The node before it is the scroller holding the cards.
    const before = screen().childNodes[screen().childNodes.indexOf(line) - 1] as HostElement;
    expect(before.querySelectorAll('[aria-label="Open Map a"]')).toHaveLength(1);
    expect(line.textContent).toBe("Map previews:© OpenMapTiles·© OpenStreetMap");
    expect(links(line)).toEqual([
      ["© OpenMapTiles", "https://openmaptiles.org"],
      ["© OpenStreetMap", "https://www.openstreetmap.org/copyright"],
    ]);
  });

  it("names Satellite's configured credit after the built-in one when a picture was drawn on it", async () => {
    await open([map("s", "satellite"), map("a", null)]);
    expect(credits()[0].textContent).toBe("Map previews:© OpenMapTiles·© OpenStreetMap·© Imagery Provider");
  });

  it("carries no line when every map shows chart paper", async () => {
    await open([map("a", null, false), map("s", "satellite", false)]);
    expect(credits()).toHaveLength(0);
  });

  it("in the list stands as the list card's foot row, under the rows, and not under the scroller", async () => {
    lists.view = "list";
    await open([map("a", "streets"), map("b", null, false)]);
    expect(credits()).toHaveLength(1);
    const [foot] = credits();
    expect(foot.dataset.pictureCredit).toBe("foot");
    const card = foot.parentElement!;
    expect(card.childNodes.at(-1)).toBe(foot);
    expect(card.querySelectorAll('[aria-label="Open Map a"]')).toHaveLength(1);
    expect(links(foot).map(([label]) => label)).toEqual(["© OpenMapTiles", "© OpenStreetMap"]);
  });
});

describe("the Maps gallery's line for an administrator when pictures have no renderer", () => {
  const notices = () => container.querySelectorAll("[data-renderer-notice]");

  it("stands at the screen's foot under the grid's credit line, when the page hands it", async () => {
    await open([map("a", null)], true);
    expect(notices()).toHaveLength(1);
    const [line] = notices();
    expect(line.parentElement).toBe(screen());
    expect(screen().childNodes.at(-1)).toBe(line);
    expect(screen().childNodes.at(-2)).toBe(credits()[0]);
    expect(line.textContent).toBe("No map pictures: this instance has no renderer. Settings · System says how to set one.");
  });

  it("stands at the screen's foot in the list too, under the scroller and not in the list card", async () => {
    lists.view = "list";
    await open([map("a", null, false)], true);
    expect(notices()).toHaveLength(1);
    expect(screen().childNodes.at(-1)).toBe(notices()[0]);
  });

  it.each([false, undefined])("is not there when the page does not hand it (%s)", async (handed) => {
    await open([map("a", null, false)], handed);
    expect(notices()).toHaveLength(0);
  });
});
