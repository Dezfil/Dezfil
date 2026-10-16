import type { Database } from "better-sqlite3";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { NavLinks } from "@/components/NavLinks";
import { TemplatesScreen } from "@/components/templates/TemplatesScreen";
import WorkspaceLayout from "../layout";
import TemplatesPage from "./page";

/**
 * The Templates entry: the rail lists it last, after SQL, in the one
 * rail every signed-in account's workspace mounts, a member's and an
 * admin's alike; its address opens the page for both, and an anonymous
 * request is sent to sign in instead.
 */

vi.mock("next/font/google", () => {
  const face = (name: string) => () => ({ variable: `font-${name}`, className: name, style: {} });
  return { Archivo: face("archivo"), DM_Mono: face("dm-mono"), Gabarito: face("gabarito"),
    IBM_Plex_Mono: face("plex-mono"), Inter: face("inter") };
});
const who = vi.hoisted(() => ({ account: null as string | null, db: null as unknown }));
vi.mock("next/headers", () => ({
  headers: async () => who.account === null
    ? socketRequest(new Request("http://instance.test/templates")).headers
    : testAccountRequest(new Request("http://instance.test/templates"), who.db as Database, who.account).headers,
}));
vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  usePathname: () => "/templates",
}));

let db: Database;
beforeEach(() => {
  db = metadata.open(":memory:");
  who.db = db;
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  testAccountScope(db, "ada");
  testAccountScope(db, "bo");
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'ada'").run();
});
afterEach(() => { vi.restoreAllMocks(); db.close(); who.account = null; });

/** Every element of a tree as built, in document order, without rendering it. */
function elements(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const props = node.props as { children?: ReactNode };
  return [node, ...elements(props.children)];
}

describe("the rail's Templates entry", () => {
  it("lists Templates last among the sections, right after SQL, and marks it on its own address", () => {
    const html = renderToStaticMarkup(<NavLinks />);
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
    expect(hrefs.slice(-2)).toEqual(["/sql", "/templates"]);
    expect(hrefs).toHaveLength(8);
    const active = [...html.matchAll(/<a [^>]*data-active="true"[^>]*>/g)].map((match) => match[0]);
    expect(active).toHaveLength(1);
    expect(active[0]).toContain('href="/templates"');
    expect(html).toContain(">Templates<");
  });

  it.each([["an admin", "ada"], ["a member", "bo"]])("is in the rail the workspace mounts for %s", async (_who, account) => {
    who.account = account;
    const tree = elements(await WorkspaceLayout({ children: <p>page</p> }));
    expect(tree.filter((element) => element.type === NavLinks)).toHaveLength(1);
  });
});

describe("the Templates address", () => {
  it.each([["an admin", "ada"], ["a member", "bo"]])("opens the page for %s", async (_who, account) => {
    who.account = account;
    const page = (await TemplatesPage()) as ReactElement;
    expect(page.type).toBe(TemplatesScreen);
  });

  it("sends an anonymous request to sign in", async () => {
    let thrown: unknown;
    try { await TemplatesPage(); } catch (error) { thrown = error; }
    expect(String((thrown as { digest?: string })?.digest)).toMatch(/^NEXT_REDIRECT;[a-z]+;\/sign-in;/);
  });
});
