import { existsSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/metadata/accounts";
import { DOCS_SITE_URL, HTTP_API_GUIDE_URL, MCP_GUIDE_URL } from "@/lib/docs-site";
vi.mock("next/navigation", () => ({ usePathname: () => "/maps" }));
import { AccountRailView } from "./AccountRail";
import { DocsScreen } from "./DocsScreen";
import { sectionFor } from "./NavLinks";
import { RailModeContext } from "./rail-mode";
import { McpCard } from "./settings/McpCard";

/**
 * Where the app points a reader at the documentation site: the MCP card in
 * Settings, the in-app API reference and the rail. Each link is the page's
 * full site address from the one address constant, opens in a new tab and
 * carries the drawn external mark; the links that were there stay.
 */
const account = { id: "one", name: "Frida Merian", email: "frida@example.test", isAdmin: true } as Account;

/** Every anchor in the markup with its attributes and inner markup. */
function anchors(html: string): { attrs: string; inner: string; href: string }[] {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map(([, attrs, inner]) => ({
    attrs,
    inner,
    href: /href="([^"]*)"/.exec(attrs)?.[1] ?? "",
  }));
}
/** The external mark is the shared ExternalIcon's drawing. */
const EXTERNAL_MARK = 'd="M14 4h6v6M20 4l-8 8"';

function expectOutbound(html: string, href: string, text: string) {
  const found = anchors(html).filter(anchor => anchor.href === href);
  expect(found, href).toHaveLength(1);
  const [link] = found;
  expect(link.attrs).toContain('target="_blank"');
  expect(link.attrs).toContain('rel="noreferrer"');
  expect(link.inner).toContain(EXTERNAL_MARK);
  expect(link.inner.replace(/<[^>]*>/g, "").trim()).toBe(text);
}

/** The repository page a site address is built from. */
function pageFile(url: string): string {
  expect(url.startsWith(DOCS_SITE_URL)).toBe(true);
  return path.join(process.cwd(), "docs", `${url.slice(DOCS_SITE_URL.length).replace(/\/$/, "")}.md`);
}

describe("the documentation site's addresses in the app", () => {
  it("name pages the repository carries", () => {
    expect(DOCS_SITE_URL).toBe("https://dezfil.io/docs/");
    expect(MCP_GUIDE_URL).toBe("https://dezfil.io/docs/reference/mcp/");
    for (const url of [MCP_GUIDE_URL, HTTP_API_GUIDE_URL]) expect(existsSync(pageFile(url)), url).toBe(true);
  });
});

describe("the MCP card's links", () => {
  it("links the MCP page in a new tab and keeps the API reference and the contract", () => {
    const html = renderToStaticMarkup(<McpCard />);
    expectOutbound(html, MCP_GUIDE_URL, "MCP server guide");
    const hrefs = anchors(html).map(anchor => anchor.href);
    expect(hrefs).toContain("/developer");
    expect(hrefs).toContain("/api/openapi.json");
    // The two links inside the app stay in this tab.
    for (const anchor of anchors(html).filter(a => a.href === "/developer" || a.href === "/api/openapi.json")) {
      expect(anchor.attrs).not.toContain("_blank");
    }
  });
});

describe("the in-app API reference's links", () => {
  it("links the HTTP API guide in a new tab beside the description and the MCP card", () => {
    const html = renderToStaticMarkup(<DocsScreen />);
    expectOutbound(html, HTTP_API_GUIDE_URL, "HTTP API guide");
    const hrefs = anchors(html).map(anchor => anchor.href);
    expect(hrefs).toContain("/api/openapi.json");
    expect(hrefs).toContain("/settings/tokens#mcp-heading");
  });
});

describe("the rail's Docs entry", () => {
  const rail = (value: Account | null, mode: "hover" | "open" | "icons" = "hover") =>
    renderToStaticMarkup(
      <RailModeContext.Provider value={mode}>
        <AccountRailView account={value} />
      </RailModeContext.Provider>,
    );

  it("opens the docs home in a new tab with the external mark, right before Settings", () => {
    for (const value of [account, { ...account, isAdmin: false }, null]) {
      const html = rail(value);
      expectOutbound(html, DOCS_SITE_URL, "Docs");
      const hrefs = anchors(html).map(anchor => anchor.href);
      expect(hrefs[hrefs.indexOf(DOCS_SITE_URL) + 1]).toBe("/settings");
    }
    // An admin's Users entry still comes first in the cluster.
    const hrefs = anchors(rail(account)).map(anchor => anchor.href);
    expect(hrefs.slice(0, 3)).toEqual(["/users", DOCS_SITE_URL, "/settings"]);
  });

  it("draws the row its neighbours draw: the icon column, then the label", () => {
    const html = rail(account);
    const [docs] = anchors(html).filter(anchor => anchor.href === DOCS_SITE_URL);
    const [settings] = anchors(html).filter(anchor => anchor.href === "/settings");
    const classes = (attrs: string) => /class="([^"]*)"/.exec(attrs)?.[1];
    expect(classes(docs.attrs)).toBe(classes(settings.attrs));
    const shape = (inner: string) => [...inner.matchAll(/<(span|svg)\b[^>]*?(?:class="([^"]*)")?[^>]*>/g)].slice(0, 3).map(m => `${m[1]}.${m[2] ?? ""}`);
    expect(shape(docs.inner)).toEqual(shape(settings.inner));
  });

  it("is never marked active and names no section", () => {
    const [docs] = anchors(rail(account)).filter(anchor => anchor.href === DOCS_SITE_URL);
    expect(docs.attrs).not.toContain("data-active");
    expect(sectionFor(DOCS_SITE_URL).href).toBe("/");
    expect(sectionFor("/docs")).toMatchObject({ href: "/", label: "Home" });
  });

  it("names itself in a hint under Icons only, as every rail entry does", () => {
    expect(anchors(rail(account, "icons")).find(anchor => anchor.href === DOCS_SITE_URL)!.attrs)
      .toMatch(/data-hint="Docs" data-hint-always=""/);
    for (const mode of ["hover", "open"] as const) {
      expect(anchors(rail(account, mode)).find(anchor => anchor.href === DOCS_SITE_URL)!.attrs).not.toContain("data-hint");
    }
  });
});
