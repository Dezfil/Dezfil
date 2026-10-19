import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapOverview } from "../api";
import { installDomHost, type HostElement } from "../testing/dom-host";
import { SignedIn } from "../sharing/signed-in";
import { browserTitle, pathObjectFor } from "../shell/path-model";
import { ProjectHomeScreen } from "./ProjectHomeScreen";
import type { HomeWorld, ProjectRecordWire } from "./home-read";

/**
 * A project's home names the project in the shell's path, and so in the
 * browser tab, for everyone who reaches it: its owner, an Editor and a
 * Viewer read the same "Berlin housing study · Dezfil".
 */

const home = vi.hoisted(() => ({ record: null as unknown }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/projects/berlin" }));
// The heading's back arrow is a link; a plain anchor stands in for next/link's.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock("../sharing/use-project-people", async (original) => ({
  ...await original<typeof import("../sharing/use-project-people")>(),
  useProjectPeople: () => new Map(),
}));
vi.mock("../builder/drawer/use-operations", () => ({ useOperations: () => ({ operations: [] }) }));
vi.mock("../AddDataDialog", () => ({ AddDataDialog: () => null }));
vi.mock("../use-upload-queue", () => ({ useUploadQueue: () => ({}) }));
vi.mock("../shell/use-project-name", () => ({ invalidateProjects: vi.fn() }));
vi.mock("./home-read", async (original) => ({
  ...await original<typeof import("./home-read")>(),
  useProjectHome: () => ({
    state: {
      status: "ready",
      value: {
        record: home.record as ProjectRecordWire,
        maps: [{ id: "m", name: "Station catchments", projectId: "berlin", layerCount: 1, layerColors: [],
          updatedAt: "2026-09-02T00:00:00Z", publishToken: null, owner: ada, home: "ada" } as unknown as MapOverview],
        workflows: [], tables: [], names: new Map(), lastRuns: new Map(),
      } satisfies HomeWorld,
    },
    retry: vi.fn(), refresh: vi.fn(), confirmMembership: vi.fn(), beginAction: vi.fn(), ownsAction: vi.fn(),
    beginSave: vi.fn(), ownsSave: vi.fn(), acceptSave: vi.fn(),
  }),
}));

const ada = { name: "Ada Okafor", sqlName: "ada" };
const bo = { name: "Bo Lindqvist", sqlName: "bo" };

let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({}, { status: 404 })));
  host = installDomHost();
  for (const id of ["header-crumb-slot"]) {
    const el = host.document.createElement("span");
    el.setAttribute("id", id);
    host.document.body.appendChild(el);
  }
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
  vi.unstubAllGlobals();
});

async function open(role: "owner" | "editor" | "viewer") {
  home.record = {
    id: "berlin", name: "Berlin housing study", note: null, createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-02T00:00:00Z", role, owner: ada,
  } satisfies ProjectRecordWire;
  await act(async () => root.render(
    <SignedIn account={role === "owner" ? ada : bo}><ProjectHomeScreen id="berlin" files={role !== "viewer"} /></SignedIn>,
  ));
}

describe("the project home's tab title", () => {
  it.each(["owner", "editor", "viewer"] as const)("names the project for its %s", async (role) => {
    await open(role);
    expect(pathObjectFor("/projects/berlin")).toEqual({ name: "Berlin housing study", projectId: null });
    expect(browserTitle({ name: pathObjectFor("/projects/berlin")?.name, section: "Projects" })).toBe("Berlin housing study · Dezfil");
  });

  it("lets the name go when the home closes", async () => {
    await open("editor");
    act(() => root.render(<span />));
    expect(pathObjectFor("/projects/berlin")).toBeNull();
  });
});

describe("the project home's back arrow", () => {
  it.each(["owner", "editor", "viewer"] as const)("leads its %s back to Projects from before the name", async (role) => {
    await open(role);
    const back = container.querySelectorAll("a").find((a) => a.getAttribute("aria-label") === "Back to Projects")!;
    expect(back).toBeTruthy();
    expect(back.getAttribute("href")).toBe("/projects");
    // The heading's first thing, beside the block that holds the name.
    const heading = back.parentElement!;
    expect(heading.children[0]).toBe(back);
    expect(heading.children[1].querySelector("h1")?.textContent).toBe("Berlin housing study");
  });
});
