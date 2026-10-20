import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BASEMAPS, SATELLITE_STYLE_URL } from "@/lib/basemap";
import type { MapOverview } from "../api";
import { SignedIn } from "../sharing/signed-in";
import { installDomHost, type HostElement } from "../testing/dom-host";
import type { Catalogue } from "./home-read";
import { ProjectHomeScreen } from "./ProjectHomeScreen";

/**
 * A project's home credits the basemaps its map pictures were drawn on
 * with one line: at the foot of the home in cards, as the Maps list card's
 * foot row in the list, and at the foot of an empty project under the
 * recent card whose rows show pictures. Maps on chart paper credit
 * nothing. The home's reads are fakes; the instance's styles are handed in
 * as the page hands them.
 */

const fake = vi.hoisted(() => ({ maps: [] as unknown[], catalogue: null as unknown }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/projects/p" }));
// The heading's back arrow is a link; a plain anchor stands in for next/link's.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock("@/components/theme", () => ({ useTheme: () => ({ theme: "light" }) }));
vi.mock("./home-read", async (original) => ({
  ...await original<typeof import("./home-read")>(),
  useProjectHome: () => ({
    state: { status: "ready", value: {
      record: { id: "p", name: "Field tests", note: null, role: "owner", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" },
      maps: fake.maps, workflows: [], tables: [], names: new Map(), lastRuns: new Map(),
    } },
    retry: vi.fn(), refresh: vi.fn(async () => true), confirmMembership: vi.fn(async () => true),
    beginAction: () => ({}), ownsAction: () => true, beginSave: () => ({}), ownsSave: () => true, acceptSave: () => true,
  }),
  useCatalogue: () => ({ state: fake.catalogue ? { status: "ready", value: fake.catalogue } : { status: "idle" }, reload: vi.fn(), retry: vi.fn() }),
}));
vi.mock("../builder/drawer/use-operations", () => ({ useOperations: () => ({ operations: [] }) }));
vi.mock("../shell/use-project-name", () => ({ invalidateProjects: vi.fn() }));
vi.mock("../shell/ProjectCrumbTail", () => ({ ProjectCrumbTail: () => null }));
vi.mock("../sharing/MembersLine", () => ({ MembersLine: () => null }));
vi.mock("../AddDataDialog", () => ({ AddDataDialog: () => null }));
vi.mock("../use-upload-queue", () => ({ useUploadQueue: () => ({}) }));
vi.mock("../MapStrip", () => ({ MapStrip: () => null }));

const bo = { name: "Bo Lindqvist", sqlName: "bo" };
const SATELLITE = { key: "satellite" as const, label: "Satellite", url: SATELLITE_STYLE_URL, kind: "imagery" as const, attribution: [{ label: "© Imagery Provider" }] };
const INSTANCE = { basemaps: [...BASEMAPS, SATELLITE], defaultUrl: BASEMAPS[0].url, overrideUrl: null, overrideAttribution: [] };

const map = (id: string, basemap: MapOverview["basemap"], hasThumbnail = true, projectId: string | null = "p"): MapOverview =>
  ({
    id, name: `Map ${id}`, viewport: { lng: 0, lat: 0, zoom: 2 }, basemap, customBasemap: null, basemapLayers: null,
    published: false, publishToken: null, publishedAt: null, hasThumbnail,
    createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z", editRevision: "r1",
    projectId, owner: bo, home: bo.sqlName, layerCount: 1, layerColors: [],
  }) as unknown as MapOverview;

let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;
beforeEach(() => {
  fake.maps = [];
  fake.catalogue = null;
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

async function open(rendererNotice?: boolean) {
  await act(async () => root.render(<SignedIn account={bo}><ProjectHomeScreen id="p" files pictureBasemaps={INSTANCE} rendererNotice={rendererNotice} /></SignedIn>));
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
const credits = () => container.querySelectorAll("[data-picture-credit]");
const content = () => container.querySelector("[data-home-content]")!;

describe("a project's home's line for its pictures", () => {
  it("stands at the foot of the home in cards and names each basemap once", async () => {
    fake.maps = [map("a", "satellite"), map("b", null), map("c", "dark")];
    await open();
    expect(credits()).toHaveLength(1);
    const [line] = credits();
    expect(line.dataset.pictureCredit).toBe("page");
    expect(line.parentElement).toBe(content());
    expect(content().childNodes.at(-1)).toBe(line);
    expect(line.textContent).toBe("Map previews:© OpenMapTiles·© OpenStreetMap·© Imagery Provider");
  });

  it("in the list stands as the Maps list card's foot row instead", async () => {
    fake.maps = [map("a", "streets")];
    await open();
    await act(async () => { container.querySelector('button[aria-label="List view"]')!.click(); });
    expect(credits()).toHaveLength(1);
    const [foot] = credits();
    expect(foot.dataset.pictureCredit).toBe("foot");
    expect(foot.closest('[data-section="map"]')).not.toBeNull();
    const card = foot.parentElement!;
    expect(card.childNodes.at(-1)).toBe(foot);
    expect(card.querySelectorAll('[aria-label="Open Map a"]')).toHaveLength(1);
  });

  it("carries no line when every map shows chart paper", async () => {
    fake.maps = [map("a", null, false), map("b", "satellite", false)];
    await open();
    expect(credits()).toHaveLength(0);
  });

  it("in an empty project stands at the foot, under the recent rows whose pictures it credits", async () => {
    const catalogue: Catalogue = { maps: [map("r", "satellite", true, null), map("q", null, false, null)], workflows: [], tables: [] };
    fake.catalogue = catalogue;
    await open();
    expect(container.querySelectorAll("[data-recent-row]")).toHaveLength(2);
    expect(credits()).toHaveLength(1);
    const [line] = credits();
    expect(content().childNodes.at(-1)).toBe(line);
    expect(line.textContent).toBe("Map previews:© Imagery Provider");
  });
});

describe("a project's home's line for an administrator when pictures have no renderer", () => {
  const notices = () => container.querySelectorAll("[data-renderer-notice]");
  const SAID = "No map pictures: this instance has no renderer. Settings · System says how to set one.";

  it("stands at the home's foot, under the credit in cards and under the sections in the list", async () => {
    fake.maps = [map("a", "dark")];
    await open(true);
    expect(notices()).toHaveLength(1);
    expect(notices()[0].textContent).toBe(SAID);
    expect(content().childNodes.at(-1)).toBe(notices()[0]);
    expect(content().childNodes.at(-2)).toBe(credits()[0]);
    await act(async () => { container.querySelector('button[aria-label="List view"]')!.click(); });
    expect(notices()).toHaveLength(1);
    expect(content().childNodes.at(-1)).toBe(notices()[0]);
    expect(notices()[0].closest('[data-section="map"]')).toBeNull();
  });

  it("stands at an empty project's foot too", async () => {
    fake.catalogue = { maps: [map("r", null, false, null)], workflows: [], tables: [] } satisfies Catalogue;
    await open(true);
    expect(notices()).toHaveLength(1);
    expect(content().childNodes.at(-1)).toBe(notices()[0]);
  });

  it("is not there when the page does not hand it", async () => {
    fake.maps = [map("a", "dark")];
    await open(false);
    expect(notices()).toHaveLength(0);
  });
});

describe("a project's home while a map it shows waits for its picture", () => {
  const pass = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
  let listing: MapOverview[];
  let asked: string[];
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    asked = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.startsWith("/api/maps")) { asked.push(url); return Response.json(listing); }
      return Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
    }));
  });
  afterEach(() => { vi.useRealTimers(); });
  const waiting = (m: MapOverview) => ({ ...m, pictureState: "waiting", pictureVersion: null, hasThumbnail: false }) as MapOverview;
  const landed = (m: MapOverview) => ({ ...m, pictureState: "current", pictureVersion: "server-1", hasThumbnail: true }) as MapOverview;
  async function openHome() {
    await act(async () => root.render(<SignedIn account={bo}><ProjectHomeScreen id="p" files pictureBasemaps={INSTANCE} /></SignedIn>));
    for (let i = 0; i < 4; i += 1) await pass(0);
  }

  it("asks the project's maps listing every five seconds until none waits, and credits the picture as it lands", async () => {
    fake.maps = listing = [waiting(map("a", "satellite"))];
    await openHome();
    expect(credits()).toHaveLength(0);
    await pass(5_000);
    expect(asked).toEqual(["/api/maps?project=p"]);
    listing = [landed(map("a", "satellite"))];
    await pass(5_000);
    expect(credits()[0]?.textContent).toBe("Map previews:© Imagery Provider");
    await pass(60_000);
    expect(asked).toHaveLength(2);
  });

  it("in an empty project asks the workspace's maps listing while a recent map waits", async () => {
    fake.catalogue = { maps: [waiting(map("r", "satellite", true, null))], workflows: [], tables: [] } satisfies Catalogue;
    listing = [landed(map("r", "satellite", true, null))];
    await openHome();
    expect(credits()).toHaveLength(0);
    await pass(5_000);
    expect(asked).toEqual(["/api/maps"]);
    expect(credits()[0]?.textContent).toBe("Map previews:© Imagery Provider");
    await pass(60_000);
    expect(asked).toHaveLength(1);
  });

  it("asks nothing when no map it shows waits", async () => {
    fake.maps = listing = [map("a", "dark")];
    await openHome();
    await pass(60_000);
    expect(asked).toEqual([]);
  });
});
