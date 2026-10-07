import type { Database } from "better-sqlite3";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import * as preferences from "@/lib/metadata/account-preferences";
import { defaultLook } from "@/lib/look";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { DezfilDocument } from "../document";
import EntryLayout from "../(entry)/layout";
import PublishedLayout from "../v/layout";
import RenderLayout from "../render/layout";
import RenderNotFound from "../render/not-found";
import RenderRootPage from "../render/page";
import RenderMissingPage from "../render/[id]/[...missing]/page";
import PublishedRootPage from "../v/page";
import PublishedMissingPage from "../v/[token]/[...missing]/page";
import WorkspaceLayout from "./layout";
import GlobalNotFound from "../global-not-found";
import WorkspaceNotFound from "./not-found";
import { pageLook } from "./page-look";

/**
 * The look is served with the workspace's document: the workspace root
 * stamps the signed-in account's picks on `<html>` as attributes in the
 * markup itself, and no other root does. A read that fails yields Dezfil's
 * default look, never a refused page and never another account's look.
 */

vi.mock("next/font/google", () => {
  const face = (name: string) => () => ({ variable: `font-${name}`, className: name, style: {} });
  return { Archivo: face("archivo"), DM_Mono: face("dm-mono"), Gabarito: face("gabarito"),
    IBM_Plex_Mono: face("plex-mono"), Inter: face("inter") };
});
const who = vi.hoisted(() => ({ account: "ada", db: null as unknown }));
vi.mock("next/headers", () => ({
  headers: async () =>
    testAccountRequest(new Request("http://instance.test/maps"), who.db as Database, who.account).headers,
}));

let db: Database;
beforeEach(() => {
  db = metadata.open(":memory:");
  who.db = db;
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  for (const id of ["ada", "bea"]) testAccountScope(db, id);
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

type Document = ReactElement<{ look?: Record<string, string>; children: ReactNode }>;
async function workspaceDocument(account: string) {
  who.account = account;
  return (await WorkspaceLayout({ children: <p>page</p> })) as Document;
}
/** The served `<html>` start tag, as the markup carries it. */
const htmlTag = (element: ReactElement) => /<html[^>]*>/.exec(renderToStaticMarkup(element))![0];
const damage = (account: string) => db.prepare(
  "INSERT INTO account_preferences (account_id, view_prefs, updated_at) VALUES (?, ?, 'damaged')").run(account, "{\"look\": {");

describe("the workspace root", () => {
  it("serves the signed-in account's look on <html>, only the picks that differ from the default", async () => {
    preferences.mergeAccountLook("ada", { color: "harbor", rail: "open", corners: "rounded" }, db);
    const document = await workspaceDocument("ada");
    expect(document.type).toBe(DezfilDocument);
    expect(document.props.look).toEqual({ "data-look-color": "harbor", "data-look-rail": "open" });
    const tag = htmlTag(document);
    expect(tag).toContain('data-look-color="harbor"');
    expect(tag).toContain('data-look-rail="open"');
    expect(tag).not.toContain("data-look-corners");
  });

  it("serves no look attribute for an account that never picked, beside one that did", async () => {
    preferences.mergeAccountLook("ada", { color: "slate", font: "system" }, db);
    const document = await workspaceDocument("bea");
    expect(document.props.look).toEqual({});
    expect(htmlTag(document)).not.toContain("data-look-");
  });

  it("serves the default look when the account's preferences cannot be read, never another account's", async () => {
    preferences.mergeAccountLook("ada", { color: "heather", background: "hex" }, db);
    damage("bea");
    expect(() => preferences.accountLook("bea", db)).toThrow();
    const document = await workspaceDocument("bea");
    expect(document.props.look).toEqual({});
    expect(htmlTag(document)).not.toContain("data-look-");
    // The account that can be read is still served its own.
    expect((await workspaceDocument("ada")).props.look).toEqual({ "data-look-color": "heather", "data-look-background": "hex" });
  });

  it("reads the look of the admitted account alone, and a read that throws yields the default", async () => {
    const read = vi.spyOn(preferences, "accountLook").mockImplementation(() => { throw new Error("store unavailable"); });
    expect((await workspaceDocument("bea")).props.look).toEqual({});
    expect(read.mock.calls.map(([account]) => account)).toEqual(["bea"]);
    expect(pageLook("ada", () => { throw new Error("store unavailable"); })).toEqual({});
    expect(pageLook("ada", () => ({ ...defaultLook(), color: "harbor" }))).toEqual({ "data-look-color": "harbor" });
  });
});

describe("the other roots", () => {
  it.each([["the entry screens", EntryLayout], ["a published page", PublishedLayout], ["the render route", RenderLayout]])(
    "serve %s with no look, whatever the signed-in account picked", (_label, Layout) => {
      preferences.mergeAccountLook("ada", { color: "harbor", contrast: "more" }, db);
      const markup = renderToStaticMarkup(Layout({ children: <p>page</p> }));
      expect(markup).toMatch(/^<html[^>]*>(<head><\/head>)?<body>/);
      expect(markup).not.toContain("data-look-");
    });

  it("keep the remembered theme's boot everywhere but on a published page", () => {
    const boot = 'localStorage.getItem("dezfil-theme")';
    expect(renderToStaticMarkup(EntryLayout({ children: null }))).toContain(boot);
    expect(renderToStaticMarkup(RenderLayout({ children: null }))).toContain(boot);
    expect(renderToStaticMarkup(PublishedLayout({ children: null }))).not.toContain(boot);
    expect(renderToStaticMarkup(<DezfilDocument>{null}</DezfilDocument>)).toContain(boot);
  });
});

describe("the route tree", () => {
  const APP = "src/app";
  function* pages(dir: string): Generator<string> {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) yield* pages(full);
      else if (/^page\.tsx?$/.test(entry)) yield full;
    }
  }
  const ROOTS = ["src/app/(workspace)", "src/app/(entry)", "src/app/v", "src/app/render"];

  it("has no top-level layout, and every page sits under exactly one of the four roots", () => {
    expect(existsSync(`${APP}/layout.tsx`)).toBe(false);
    const found = [...pages(APP)];
    expect(found.length).toBeGreaterThan(10);
    for (const page of found) {
      const roots = ROOTS.filter(root => page.startsWith(`${root}/`) && existsSync(`${root}/layout.tsx`));
      expect(roots, page).toHaveLength(1);
    }
  });

  it("keeps the render view where the export drift check reads it", () => {
    expect(existsSync("src/app/render/[id]/RenderExportView.tsx")).toBe(true);
    expect(existsSync("src/app/render/[id]/page.tsx")).toBe(true);
  });

  it("catches an unknown address under the published and the render root inside that root, never the workspace's not-found", () => {
    // Without these, `/v`, `/v/<token>/extra`, `/render` and `/render/<id>/extra`
    // match no page of their own root and fall to the framework's not-found.
    const scoped: [string, () => never, string][] = [
      ["src/app/v/page.tsx", PublishedRootPage, "src/app/v/not-found.tsx"],
      ["src/app/v/[token]/[...missing]/page.tsx", PublishedMissingPage, "src/app/v/not-found.tsx"],
      ["src/app/render/page.tsx", RenderRootPage, "src/app/render/not-found.tsx"],
      ["src/app/render/[id]/[...missing]/page.tsx", RenderMissingPage, "src/app/render/not-found.tsx"],
    ];
    for (const [page, Page, notFoundPage] of scoped) {
      expect(existsSync(page), page).toBe(true);
      expect(existsSync(notFoundPage), notFoundPage).toBe(true);
      let thrown: unknown;
      try { Page(); } catch (error) { thrown = error; }
      expect((thrown as { digest?: string }).digest, page).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
    }
    expect(renderToStaticMarkup(<RenderNotFound />)).toBe("<h1>Page not found</h1>");
  });

  it("hands any other unknown address to the framework's not-found, drawn as the workspace's not-found page", async () => {
    // A catch-all page inside the workspace answers 200: the workspace holds
    // its pages out of the server render until the session is confirmed, so
    // the page's not-found never sets the status. The framework's own
    // not-found sets 404 before rendering; it is switched on in the config.
    const workspace = path.join(APP, "(workspace)");
    const catchAlls = readdirSync(workspace).filter(entry => /^\[\[?\.\.\./.test(entry));
    expect(catchAlls).toEqual([]);
    expect(readFileSync("next.config.ts", "utf8")).toMatch(/experimental:\s*\{[^}]*\bglobalNotFound:\s*true\b/);
    const page = GlobalNotFound();
    expect(page.type).toBe(WorkspaceLayout);
    expect((page.props as { children: ReactElement }).children.type).toBe(WorkspaceNotFound);
    // Drawn whole for the signed-in person: the document with their look.
    preferences.mergeAccountLook("ada", { color: "harbor" }, db);
    who.account = "ada";
    const document = (await WorkspaceLayout(page.props as { children: ReactNode })) as Document;
    expect(htmlTag(document)).toContain('data-look-color="harbor"');
    const markup = renderToStaticMarkup(<WorkspaceNotFound />);
    expect(markup).toContain("<h1>Page not found</h1>");
    expect(markup).toContain('href="/"');
  });
});
