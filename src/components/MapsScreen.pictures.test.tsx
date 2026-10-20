import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapOverview } from "./api";
import { installDomHost, type HostElement } from "./testing/dom-host";
import { MapsScreen } from "./MapsScreen";
import { SignedIn } from "./sharing/signed-in";

/**
 * The Maps page asks its own listing again, for its scope, while a card it
 * shows waits for a picture: every five seconds, until none waits; the new
 * picture shows on its card with no reload. A waiting map the page's
 * filter hides is not a card on the page and asks nothing. The world and
 * the view preference are fakes; the listing the poll asks is the
 * browser's fetch.
 */

const lists = vi.hoisted(() => ({ world: null as unknown }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock("@/components/theme", () => ({ useTheme: () => ({ theme: "light" }) }));
vi.mock("./use-view-prefs", async (original) => ({
  ...(await original<typeof import("./use-view-prefs")>()),
  useViewPrefs: () => ({ view: "grid", sort: "edited", settled: true, setView: vi.fn(), setSort: vi.fn() }),
}));
vi.mock("./scope/use-scope", () => ({ useProjectScope: () => ({ scope: { kind: "project", id: "p1" }, setScope: vi.fn() }) }));
vi.mock("./scope/use-scope-world", () => ({
  useScopeWorld: () => ({ state: { status: "ready", value: lists.world }, retry: vi.fn(), mutate: vi.fn(), refresh: vi.fn() }),
}));

const bo = { name: "Bo Lindqvist", sqlName: "bo" };
const map = (id: string, picture: Partial<MapOverview>, published = false): MapOverview =>
  ({
    id, name: `Map ${id}`, viewport: { lng: 0, lat: 0, zoom: 2 }, basemap: null, customBasemap: null, basemapLayers: null,
    published, publishToken: published ? `t-${id}` : null, publishedAt: null,
    pictureState: "current", pictureVersion: null, hasThumbnail: false, thumbnailBasemap: null,
    createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z", editRevision: "r1",
    projectId: "p1", owner: bo, home: bo.sqlName, layerCount: 1, layerColors: [], ...picture,
  }) as unknown as MapOverview;
const waiting = { pictureState: "waiting" } as const;
const landed = { pictureState: "current", pictureVersion: "server-1", hasThumbnail: true } as const;

let listing: MapOverview[];
let asked: string[];
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  asked = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.startsWith("/api/maps")) { asked.push(url); return Response.json(listing); }
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
  vi.useRealTimers();
});

const pass = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
async function open(maps: MapOverview[]) {
  lists.world = { projects: [{ id: "p1", name: "Harbour", owner: bo, role: "owner" }], all: maps, scoped: maps };
  await act(async () => root.render(<SignedIn account={bo}><MapsScreen /></SignedIn>));
  await pass(0);
}
const pictureOf = (name: string) =>
  container.querySelectorAll("[role=\"link\"]").find((card) => card.getAttribute("aria-label") === `Open ${name}`)
    ?.querySelector("img")?.getAttribute("src") ?? null;

describe("the Maps page while a card waits for its picture", () => {
  it("asks its scope's listing every five seconds until none waits, and shows the new picture with no reload", async () => {
    listing = [map("a", waiting), map("b", landed)];
    await open(listing);
    expect(pictureOf("Map a")).toBeNull();
    await pass(5_000);
    expect(asked).toEqual(["/api/maps?project=p1"]);
    listing = [map("a", landed), map("b", landed)];
    await pass(5_000);
    expect(asked).toEqual(["/api/maps?project=p1", "/api/maps?project=p1"]);
    expect(pictureOf("Map a")).toBe("/api/maps/a/thumbnail?v=server-1&theme=light");
    await pass(60_000);
    expect(asked).toHaveLength(2);
  });

  it("asks again when its next read of the listing has the card waiting after an answer said it failed", async () => {
    const onOne = { pictureState: "waiting", pictureVersion: "server-1", hasThumbnail: true } as const;
    listing = [map("a", onOne)];
    await open(listing);
    await pass(5_000);
    expect(asked).toHaveLength(1);
    listing = [map("a", { ...onOne, pictureState: "failed" })];
    await pass(5_000);
    expect(asked).toHaveLength(2);
    await pass(60_000);
    expect(asked).toHaveLength(2);
    // The work is tried again, and the page reads its scope's listing anew.
    await open([map("a", onOne)]);
    listing = [map("a", landed)];
    await pass(5_000);
    expect(asked).toHaveLength(3);
    expect(pictureOf("Map a")).toBe("/api/maps/a/thumbnail?v=server-1&theme=light");
  });

  it("keeps a landed picture on its card when the page only filters what it already read", async () => {
    listing = [map("a", waiting, true)];
    await open(listing);
    listing = [map("a", landed, true)];
    await pass(5_000);
    expect(pictureOf("Map a")).toBe("/api/maps/a/thumbnail?v=server-1&theme=light");
    await act(async () => {
      container.querySelectorAll("button").find((b) => b.textContent?.startsWith("Published"))!.click();
    });
    expect(pictureOf("Map a")).toBe("/api/maps/a/thumbnail?v=server-1&theme=light");
    await pass(60_000);
    expect(asked).toHaveLength(1);
  });

  it("asks nothing for a waiting map its filter hides", async () => {
    listing = [map("a", waiting), map("b", landed, true)];
    await open(listing);
    await act(async () => {
      container.querySelectorAll("button").find((b) => b.textContent?.startsWith("Published"))!.click();
    });
    await pass(60_000);
    expect(asked).toEqual([]);
  });
});
