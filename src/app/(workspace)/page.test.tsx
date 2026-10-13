import type { Database } from "better-sqlite3";
import { existsSync } from "node:fs";
import path from "node:path";
import { act, isValidElement, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateList } from "@/lib/templates/card";
import * as metadata from "@/lib/metadata/db";
import { accountLabels } from "@/lib/metadata/accounts";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import type { MapOverview, TableListing } from "@/components/api";
import { HomeScreen } from "@/components/home/HomeScreen";
import { homeView, type HomeView } from "@/components/home/home-model";
import { homeProjects } from "@/components/home/home-reads";
import { HeaderCrumbs, NavLinks } from "@/components/NavLinks";
import type { ProjectOverview } from "@/components/projects/model";
import { recentHref } from "@/components/projects/RecentList";
import type { RecentItem } from "@/components/projects/recent-model";
import { InstanceChip } from "@/components/shell/InstanceChip";
import { installDomHost } from "@/components/testing/dom-host";
import type { WorkflowListing } from "@/components/workflow-model";
import { GET as listMaps } from "@/app/api/maps/route";
import { GET as listProjects } from "@/app/api/projects/route";
import { GET as listRecipes } from "@/app/api/recipes/route";
import { GET as listTables } from "@/app/api/tables/route";
import WorkspaceLayout from "./layout";
import HomePage from "./page";

/**
 * Home's address: first in the rail, under the header path Dezfil, the
 * instance's chip only when the instance is named, then Home; it opens
 * Home for an admin, a member and a viewer alike, and sends an anonymous
 * request to sign in. The placeholder it replaces is gone, words and
 * module. And Home is the same for the same reach whatever the account's
 * role: read through the list operations as each account, the lead and
 * the rows come out of what that account reaches, and administrator
 * status adds nothing.
 *
 * Pat owns project P, where Bo is an editor and Viv a viewer; Pat's map M
 * and workflow W are filed there. Viv's own map V is private and her
 * latest change; Bo's own map B is his. Ada is an admin outside P.
 */

vi.mock("next/font/google", () => {
  const face = (name: string) => () => ({ variable: `font-${name}`, className: name, style: {} });
  return { Archivo: face("archivo"), DM_Mono: face("dm-mono"), Gabarito: face("gabarito"),
    IBM_Plex_Mono: face("plex-mono"), Inter: face("inter") };
});
const who = vi.hoisted(() => ({ account: null as string | null, db: null as unknown }));
vi.mock("next/headers", () => ({
  headers: async () => who.account === null
    ? socketRequest(new Request("http://instance.test/")).headers
    : testAccountRequest(new Request("http://instance.test/"), who.db as Database, who.account).headers,
}));
vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const T1 = "2026-10-01T09:00:00.000Z";
const T2 = "2026-10-02T09:00:00.000Z";
const T3 = "2026-10-03T09:00:00.000Z";

let db: Database;
beforeEach(() => {
  db = metadata.open(":memory:");
  who.db = db;
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  for (const id of ["ada", "pat", "bo", "viv"]) testAccountScope(db, id);
  db.exec(`UPDATE accounts SET is_admin = 1 WHERE id = 'ada';
    INSERT INTO projects (id, name, created_at, updated_at, owner_id) VALUES ('P', 'Survey', '${T1}', '${T1}', 'pat');
    INSERT INTO project_people VALUES ('P', 'bo', 'editor', '${T1}'), ('P', 'viv', 'viewer', '${T1}');
    INSERT INTO maps (id, name, created_at, updated_at, owner_id, project_id, last_changed_at, last_changed_by) VALUES
      ('M', 'Station catchments', '${T1}', '${T2}', 'pat', 'P', '${T2}', 'pat'),
      ('V', 'Viv sketch', '${T1}', '${T3}', 'viv', NULL, '${T3}', 'viv'),
      ('B', 'Bo draft', '${T1}', '${T1}', 'bo', NULL, '${T1}', 'bo');
    INSERT INTO recipes (id, name, origin, created_at, updated_at, owner_id, project_id, last_changed_at, last_changed_by)
      VALUES ('W', 'Permit geocoding', 'workflow', '${T1}', '${T2}', 'pat', 'P', '${T2}', 'pat');`);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  db.close();
  who.account = null;
});

/** Every element of a tree as built, in document order, without rendering it. */
function elements(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const props = node.props as { children?: ReactNode };
  return [node, ...elements(props.children)];
}

describe("Home's place in the shell", () => {
  it("is the rail's first entry, marked on its own address", () => {
    const html = renderToStaticMarkup(<NavLinks />);
    const links = [...html.matchAll(/<a [^>]*href="([^"]+)"[^>]*>/g)];
    expect(links[0][1]).toBe("/");
    expect(links[0][0]).toContain('data-active="true"');
    expect(links.filter((link) => link[0].includes('data-active="true"'))).toHaveLength(1);
    expect(html).toContain(">Home<");
  });

  it("reads Home in the header path after the wordmark and the instance's chip", () => {
    const html = renderToStaticMarkup(<HeaderCrumbs />);
    expect([...html.matchAll(/<a [^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/g)].map((m) => [m[1], m[2]])).toEqual([["/", "Home"]]);
  });

  it.each([["an admin", "ada"], ["a member", "bo"], ["a viewer", "viv"]])(
    "is mounted for %s under the head card's wordmark, chip and path, in that order",
    async (_who, account) => {
      who.account = account;
      const tree = elements(await WorkspaceLayout({ children: <p>page</p> }));
      const head = tree.filter((element) =>
        (element.props as { href?: string }).href === "/" || element.type === InstanceChip || element.type === HeaderCrumbs);
      expect(head.map((element) => (element.type === InstanceChip ? "chip" : element.type === HeaderCrumbs ? "path" : "wordmark")))
        .toEqual(["wordmark", "chip", "path"]);
      expect((head[0].props as { children?: ReactNode }).children).toBe("Dezfil");
      expect(tree.filter((element) => element.type === NavLinks)).toHaveLength(1);
    },
  );
});

describe("the instance's chip beside the wordmark", () => {
  /** The chip as the shell mounts it, with the instance's settings read
   * answering `instanceName`; a fresh store each time. Null when no chip
   * is drawn at all. */
  async function chipFor(instanceName: string | null): Promise<string | null> {
    const host = installDomHost();
    try {
      vi.stubGlobal("fetch", vi.fn(async (url: string) =>
        url === "/api/settings" ? Response.json({ instanceName }) : Response.json({}, { status: 404 })));
      vi.resetModules();
      const { InstanceChip: Chip } = await import("@/components/shell/InstanceChip");
      const container = host.document.createElement("div");
      host.document.body.appendChild(container);
      const root = createRoot(container as unknown as Element);
      await act(async () => root.render(<Chip />));
      for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      const chip = container.querySelector("span");
      const text = chip ? chip.textContent : null;
      act(() => root.unmount());
      return text;
    } finally {
      host.uninstall();
    }
  }

  it("names the instance when it is named", async () => {
    expect(await chipFor("Atlas")).toBe("Atlas");
  });

  it("is absent when the instance has no name, never an empty pill", async () => {
    expect(await chipFor(null)).toBeNull();
  });
});

describe("the Home address", () => {
  it.each([["an admin", "ada"], ["a member", "bo"], ["a viewer", "viv"]])("opens Home for %s", async (_who, account) => {
    who.account = account;
    const page = (await HomePage()) as ReactElement;
    expect(page.type).toBe(HomeScreen);
  });

  it("sends an anonymous request to sign in", async () => {
    let thrown: unknown;
    try { await HomePage(); } catch (error) { thrown = error; }
    expect(String((thrown as { digest?: string })?.digest)).toMatch(/^NEXT_REDIRECT;[a-z]+;\/sign-in;/);
  });

  it("holds none of the placeholder's words, and the placeholder is gone", () => {
    // The lists are still being read: the page draws its welcome, nothing else yet.
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const html = renderToStaticMarkup(<HomeScreen />);
    expect(html).toContain("Welcome");
    for (const word of ["Welcome to Dezfil", "Getting started", "Documentation", "Template maps",
      "Enrich your project with open data", "Start creating workflows", "Learn to build with Dezfil", "coming soon"]) {
      expect(html).not.toContain(word);
    }
    expect(existsSync(path.join(process.cwd(), "src/components/HomeScreen.tsx"))).toBe(false);
    expect(existsSync(path.join(process.cwd(), "src/components/HomeScreen.module.css"))).toBe(false);
  });
});

describe("Home is what the account reaches, whatever its role", () => {
  const TEMPLATES: TemplateList = {
    templates: [{
      id: "harbour", kind: "map", version: 1, title: "Harbour depths", question: "Where can ships berth?", place: "Hamburg",
      tags: [], dataDate: "2026", sources: [], steps: null, origin: "shipped", installed: 1, listed: null, present: true,
      size: 1, picture: "kept",
    }],
    catalogue: { state: "off", host: null, folder: false, readAt: null, reason: null, status: null },
    downloads: { versions: 0, bytes: 0 },
  };

  async function read<T>(account: string, address: string, route: (request: Request) => Promise<Response>): Promise<T> {
    const response = await route(testAccountRequest(new Request(`http://instance.test${address}`), db, account));
    expect(response.status).toBe(200);
    return (await response.json()) as T;
  }

  /** Home as the account's reads answer it: the lists through their own
   * operations, the person as the shell names them. */
  async function homeOf(account: string): Promise<HomeView> {
    const [maps, recipes, tables, projects] = await Promise.all([
      read<MapOverview[]>(account, "/api/maps", listMaps),
      read<{ recipes: WorkflowListing[] }>(account, "/api/recipes?origin=workflow", listRecipes),
      read<TableListing[]>(account, "/api/tables", listTables),
      read<ProjectOverview[]>(account, "/api/projects", listProjects),
    ]);
    const label = accountLabels([account], db).get(account)!;
    return homeView({
      maps: { status: "ready", value: maps },
      workflows: { status: "ready", value: recipes.recipes },
      tables: { status: "ready", value: tables },
      projects: { status: "ready", value: homeProjects(projects) },
      templates: { status: "ready", value: TEMPLATES },
    }, { name: label.name, sqlName: label.sqlName });
  }

  const leadOf = (view: HomeView) =>
    view.lead.kind === "continue" ? `${view.lead.item.kind}:${view.lead.item.id}` : view.lead.kind === "template" ? `template:${view.lead.card.id}` : view.lead.kind;
  const rowsOf = (view: HomeView) =>
    view.recent.state === "shown"
      ? view.recent.items.map((item) => [recentHref({ ...item, where: item.where ?? [] } as RecentItem), item.owner?.sqlName ?? null])
      : view.recent.state;

  it("leads a viewer with their own private map, the shared work in Recent wearing its owner and opening its own page", async () => {
    const pat = accountLabels(["pat"], db).get("pat")!;
    const viv = await homeOf("viv");
    expect(leadOf(viv)).toBe("map:V");
    expect(viv.lead.kind === "continue" && viv.lead.owner).toBeNull();
    expect(viv.welcome).toBe("Welcome back, viv");
    expect(rowsOf(viv)).toEqual([["/maps/M", pat.sqlName], ["/workflows/W", pat.sqlName]]);
  });

  it("gives an admin exactly what the same account sees as a member", async () => {
    const asMember = await homeOf("bo");
    expect(leadOf(asMember)).toBe("map:B");
    db.exec("UPDATE accounts SET is_admin = 1 WHERE id = 'bo'");
    expect(await homeOf("bo")).toEqual(asMember);
  });

  it("reaches nothing more for an admin outside the shared project", async () => {
    const ada = await homeOf("ada");
    expect(leadOf(ada)).toBe("template:harbour");
    expect(ada.recent).toEqual({ state: "absent" });
    expect(ada.runRows).toEqual([]);
  });
});
