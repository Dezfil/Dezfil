import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapOverview } from "./api";
import { installDomHost, type HostElement } from "./testing/dom-host";
import { MapsScreen } from "./MapsScreen";
import { SignedIn } from "./sharing/signed-in";

/**
 * The Maps list's Publish quick action under who may publish. While the
 * instance's rule holds the person back, Publish is drawn disabled with
 * the rule's one sentence as its hint and a click sends nothing; a
 * published map keeps its Copy share link. With no rule holding them
 * back, or no rule read, Publish is offered as it always was. The
 * runtime read, the account and the list's world are fakes.
 */

const lists = vi.hoisted(() => ({ world: null as unknown }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/theme", () => ({ useTheme: () => ({ theme: "light" }) }));
vi.mock("./use-view-prefs", async (original) => ({
  ...(await original<typeof import("./use-view-prefs")>()),
  useViewPrefs: () => ({ view: "grid", sort: "edited", settled: true, setView: vi.fn(), setSort: vi.fn() }),
}));
vi.mock("./scope/use-scope", () => ({ useProjectScope: () => ({ scope: { kind: "all" }, setScope: vi.fn() }) }));
vi.mock("./scope/use-scope-world", () => ({
  useScopeWorld: () => ({ state: { status: "ready", value: lists.world }, retry: vi.fn(), mutate: vi.fn(), refresh: vi.fn() }),
}));

const ADMINS_ONLY = "Only admins can publish maps on this instance.";
const NO_ONE = "No one can publish maps on this instance.";
const bo = { name: "Bo Lindqvist", sqlName: "bo" };

const map = (id: string, name: string, published: boolean): MapOverview =>
  ({
    id, name, viewport: { lng: 0, lat: 0, zoom: 2 }, basemap: null, customBasemap: null, basemapLayers: null,
    note: null, legendCorner: null, legendOrder: null, timeline: null, widgets: [], widgetsPublished: false,
    publishToken: published ? `token-${id}` : null, publishedAt: published ? "2026-09-01T00:00:00Z" : null, published,
    createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z", editRevision: "r1",
    projectId: null, owner: bo, home: bo.sqlName, layerCount: 1, layerColors: [],
  }) as unknown as MapOverview;

let rule: string | null;
let admin: boolean;
let fetchSpy: ReturnType<typeof vi.fn>;
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;

beforeEach(() => {
  rule = "everyone";
  admin = false;
  lists.world = { projects: [], all: [], scoped: [map("m-draft", "Berth occupancy", false), map("m-live", "Station catchments", true)] };
  fetchSpy = vi.fn(async (input: string) => {
    const url = String(input);
    if (url === "/api/config") {
      return rule === null ? Response.json({ error: { code: "internal", message: "Unavailable." } }, { status: 500 })
        : Response.json({ rules: { "publishing.publish": rule } });
    }
    if (url === "/api/account") return Response.json({ account: { id: "a1", isAdmin: admin } });
    if (url.endsWith("/publish")) return Response.json({ token: "t", publishedAt: "2026-10-08T00:00:00Z", editRevision: "r2" });
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
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}
async function open() {
  await act(async () => root.render(<SignedIn account={bo}><MapsScreen /></SignedIn>));
  await settle();
}
const publishButton = () => container.querySelector('button[aria-label="Publish Berth occupancy"]');
const publishCalls = () => fetchSpy.mock.calls.filter(([url]) => String(url).endsWith("/publish"));

describe("the Maps list's Publish under who may publish", () => {
  it("offers Publish when the rule lets everyone publish", async () => {
    await open();
    expect(publishButton()?.disabled).toBe(false);
    expect(publishButton()?.dataset.hint).toBe("Publish map");
    await act(async () => publishButton()!.click());
    await settle();
    expect(publishCalls()).toHaveLength(1);
  });

  it("draws Publish disabled with the sentence for a member under Admins only, and a click sends nothing", async () => {
    rule = "admins";
    await open();
    expect(publishButton()?.disabled).toBe(true);
    expect(publishButton()?.dataset.hint).toBe(ADMINS_ONLY);
    await act(async () => publishButton()!.click());
    await settle();
    expect(publishCalls()).toHaveLength(0);
  });

  it("draws Publish disabled with the No one sentence for an admin under No one", async () => {
    rule = "none";
    admin = true;
    await open();
    expect(publishButton()?.disabled).toBe(true);
    expect(publishButton()?.dataset.hint).toBe(NO_ONE);
  });

  it("offers Publish to an admin under Admins only", async () => {
    rule = "admins";
    admin = true;
    await open();
    expect(publishButton()?.disabled).toBe(false);
    expect(publishButton()?.dataset.hint).toBe("Publish map");
  });

  it("offers Publish when the rule could not be read", async () => {
    rule = null;
    await open();
    expect(publishButton()?.disabled).toBe(false);
    expect(publishButton()?.dataset.hint).toBe("Publish map");
  });

  it("keeps a published map's Copy share link while the rule holds the person back", async () => {
    rule = "admins";
    await open();
    const copy = container.querySelector('button[aria-label="Copy share link for Station catchments"]');
    expect(copy?.disabled).toBe(false);
  });
});
