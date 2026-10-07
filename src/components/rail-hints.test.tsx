import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/metadata/accounts";
vi.mock("next/navigation", () => ({ usePathname: () => "/maps" }));
import { RailModeContext, railModeOf, type RailMode } from "./rail-mode";
import { NavLinks, RailSettingsLink, RailUsersLink } from "./NavLinks";
import { UserBadge } from "./UserBadge";

/**
 * Under Icons only the rail never opens, so each item names itself in a
 * hint beside its icon: every link by its label, the account row by the
 * person's name. Under the other two picks the labels are on screen
 * (open) or one rest away (hover), and no item carries a hint.
 */
const account = { id: "one", name: "Frida Merian", email: "frida@example.test", isAdmin: true } as Account;
const LABELS = ["Home", "Projects", "Maps", "Workflows", "Data", "Connections", "SQL", "Developer", "Users", "Settings"];

function railItems(mode: RailMode): string {
  return renderToStaticMarkup(
    <RailModeContext.Provider value={mode}>
      <NavLinks />
      <RailUsersLink />
      <RailSettingsLink />
      <UserBadge account={account} />
    </RailModeContext.Provider>,
  );
}
/** The hints on the rail's items, the sign-out control's own left aside. */
const itemHints = (html: string) =>
  [...html.matchAll(/data-hint="([^"]*)"/g)].map(match => match[1]).filter(text => text !== "Sign out");

describe("the rail's hints", () => {
  it("names every link and the account row under Icons only", () => {
    const html = railItems("icons");
    expect(itemHints(html).sort()).toEqual([...LABELS, "Frida Merian"].sort());
    // The labels are in the markup but never shown: the hint shows anyway.
    for (const label of LABELS) {
      expect(html).toMatch(new RegExp(`data-hint="${label}" data-hint-always=""`));
    }
  });

  it("carries no item hint under Opens on hover or Always open", () => {
    for (const mode of ["hover", "open"] as const) expect(itemHints(railItems(mode)), mode).toEqual([]);
  });

  it("reads the pick from the root's attribute, today's behavior for anything else", () => {
    expect(railModeOf(undefined)).toBe("hover");
    expect(railModeOf("open")).toBe("open");
    expect(railModeOf("icons")).toBe("icons");
    expect(railModeOf("hover")).toBe("hover");
    expect(railModeOf("sideways")).toBe("hover");
  });
});
