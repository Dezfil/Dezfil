import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MapOverview } from "../api";
import { ProjectHomeScreen } from "./ProjectHomeScreen";
import type { HomeWorld, ProjectRecordWire } from "./home-read";
import { SignedIn } from "../sharing/signed-in";

/**
 * A shared project's home, as its people see it: one quiet line under the
 * name (the owner's initials, one's role, whose project it is); an Editor
 * keeps Add to project and Export, a Viewer has Export alone; neither gets
 * renaming (in the head or the header path), the note's edit or the
 * project menu. The owner's home is unchanged.
 */

const home = vi.hoisted(() => ({ record: null as unknown, crumb: "", people: null as unknown, empty: false }));
vi.mock("../sharing/use-project-people", async (original) => ({
  ...await original<typeof import("../sharing/use-project-people")>(),
  useProjectPeople: () => new Map(home.people ? [["berlin", home.people]] : []),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/projects/berlin" }));
vi.mock("../builder/drawer/use-operations", () => ({ useOperations: () => ({ operations: [] }) }));
vi.mock("../AddDataDialog", () => ({ AddDataDialog: () => null }));
vi.mock("../use-upload-queue", () => ({ useUploadQueue: () => ({}) }));
vi.mock("../shell/use-project-name", () => ({ invalidateProjects: vi.fn() }));
vi.mock("../shell/ProjectCrumbTail", () => ({
  ProjectCrumbTail: () => { home.crumb = "renaming"; return null; },
}));
vi.mock("../shell/PlainCrumbTail", () => ({
  PlainCrumbTail: ({ name }: { name: string }) => { home.crumb = `plain:${name}`; return null; },
}));
vi.mock("./home-read", async (original) => ({
  ...await original<typeof import("./home-read")>(),
  useProjectHome: () => ({
    state: {
      status: "ready",
      value: {
        record: home.record as ProjectRecordWire,
        maps: home.empty ? [] : [{ id: "m", name: "Station catchments", projectId: "berlin", layerCount: 1, layerColors: [],
          updatedAt: "2026-09-02T00:00:00Z", publishToken: null, owner: ada, home: "ada" } as unknown as MapOverview],
        workflows: [], tables: [], names: new Map(), lastRuns: new Map(),
      } satisfies HomeWorld,
    },
    retry: vi.fn(), refresh: vi.fn(), confirmMembership: vi.fn(), beginAction: vi.fn(), ownsAction: vi.fn(),
    beginSave: vi.fn(), ownsSave: vi.fn(), acceptSave: vi.fn(),
  }),
}));

const ada = { name: "Ada Okafor", sqlName: "ada" };
const record = (role: "owner" | "editor" | "viewer"): ProjectRecordWire => ({
  id: "berlin", name: "Berlin housing study", note: "Where rent pressure meets the tram.",
  createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z", role, owner: ada,
});
/** `files`: whether the reader may file into the project now, as the page
 * asks the server: an owner or an Editor of a project whose owner is active. */
const render = (role: "owner" | "editor" | "viewer", files = role !== "viewer") => {
  home.record = record(role);
  home.crumb = "";
  return renderToStaticMarkup(
    <SignedIn account={{ name: "Bo Lindqvist", sqlName: "bo" }}>
      <ProjectHomeScreen id="berlin" files={files} />
    </SignedIn>,
  );
};

describe("a shared project's home", () => {
  it("gives an Editor the role line, Add to project and Export, and nothing of the owner's", () => {
    const html = render("editor");
    expect(html).toContain('data-role-line="editor"');
    expect(html).toContain("Ada Okafor’s project");
    expect(html).toContain("Add to project");
    expect(html).toContain("Export project");
    expect(html).not.toContain('aria-label="More"');
    expect(html).not.toContain(">edit<");
    expect(html).toContain("Where rent pressure meets the tram.");
    expect(home.crumb).toBe("plain:Berlin housing study");
  });

  it("marks Ada's map in the project's sections with her initials", () => {
    const html = render("editor");
    expect(html).toContain('data-owner-pill="ada"');
    expect(html).toContain('data-hint="Shared by Ada Okafor"');
  });

  it("gives a Viewer Export alone", () => {
    const html = render("viewer");
    expect(html).toContain('data-role-line="viewer"');
    expect(html).toContain("<b>Viewer</b>");
    expect(html).toContain("Export project");
    expect(html).not.toContain("Add to project");
    expect(html).not.toContain('aria-label="More"');
    expect(html).not.toContain(">edit<");
    expect(home.crumb).toBe("plain:Berlin housing study");
  });

  it("offers an Editor no Add to project while the project's owner is deactivated", () => {
    const html = render("editor", false);
    expect(html).toContain('data-role-line="editor"');
    expect(html).toContain("Export project");
    expect(html).not.toContain("Add to project");
  });

  it("offers nothing to add to an empty project while its owner is deactivated", () => {
    home.empty = true;
    const open = render("editor");
    const frozen = render("editor", false);
    home.empty = false;
    expect(open).toContain("data-recent");
    expect(frozen).not.toContain("data-recent");
    expect(frozen).not.toContain("data-empty-plate");
    expect(frozen).toContain("This project is empty.");
  });

  it("gives the owner the Share action beside Add to project and Export project", () => {
    const html = render("owner");
    expect(html).toContain("data-share-action");
    expect(html.indexOf("Export project")).toBeLessThan(html.indexOf("data-share-action"));
  });

  it("gives the owner the members line under the name: who it is shared with", () => {
    home.people = [
      { name: "Ada Okafor", sqlName: "ada", role: "owner", deactivated: false },
      { name: "Bo Lindqvist", sqlName: "bo", role: "editor", deactivated: false },
      { name: "Cy Marsh", sqlName: "cy", role: "viewer", deactivated: true },
    ];
    const html = render("owner");
    expect(html).toContain('data-members-line="shared"');
    expect(html).toContain("Shared with Bo and Cy");
    home.people = null;
  });

  it("says Only you · Share on a project shared with nobody", () => {
    home.people = [{ name: "Ada Okafor", sqlName: "ada", role: "owner", deactivated: false }];
    const html = render("owner");
    expect(html).toContain('data-members-line="none"');
    expect(html).toMatch(/Only you.*·.*Share/);
    home.people = null;
  });

  it.each(["editor", "viewer"] as const)("gives a%s neither Share nor the members line", (role) => {
    home.people = [{ name: "Ada Okafor", sqlName: "ada", role: "owner", deactivated: false }];
    const html = render(role);
    expect(html).not.toContain("data-share-action");
    expect(html).not.toContain("data-members-line");
    home.people = null;
  });

  it("leaves the owner's home as it was", () => {
    const html = render("owner");
    expect(html).not.toContain("data-role-line");
    expect(html).toContain("Add to project");
    expect(html).toContain(">edit<");
    expect(html).toContain('aria-label="More"');
    expect(home.crumb).toBe("renaming");
  });
});
