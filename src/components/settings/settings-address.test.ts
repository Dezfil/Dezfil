import { describe, expect, it } from "vitest";
import { resolveSettingsAddress, tabAddress } from "./settings-address";

const open = (pathname: string, hash = "", admin = true, lastTab: string | null = null) =>
  resolveSettingsAddress({ pathname, hash, admin, lastTab });

describe("the Settings addresses", () => {
  it("gives every tab its own address and every row a fragment inside it", () => {
    expect(tabAddress("limits")).toBe("/settings/limits");
    expect(tabAddress("limits", "set-query-time")).toBe("/settings/limits#set-query-time");
    expect(tabAddress("account", null)).toBe("/settings/account");
  });

  it("opens a tab's address as it is, and a row's address on its row", () => {
    expect(open("/settings/tokens")).toEqual({ tab: "tokens", anchor: null, address: "/settings/tokens", replace: false });
    expect(open("/settings/limits", "#set-query-time")).toEqual({
      tab: "limits", anchor: "set-query-time", address: "/settings/limits#set-query-time", replace: false,
    });
    expect(open("/settings/general/")).toMatchObject({ tab: "general", replace: true, address: "/settings/general" });
  });

  it("opens Account for a tab the person cannot see, as for any unknown tab", () => {
    expect(open("/settings/limits", "", false)).toEqual({ tab: "account", anchor: null, address: "/settings/account", replace: true });
    expect(open("/settings/system", "#set-version", false)).toEqual({ tab: "account", anchor: null, address: "/settings/account", replace: true });
    expect(open("/settings/ai")).toMatchObject({ tab: "account", anchor: null, replace: true });
    expect(open("/settings/limits/deeper")).toMatchObject({ tab: "account", anchor: null, replace: true });
  });

  it("opens Maps, Workflows & SQL and Publishing for an admin, each row at its own address, and Account for anyone else", () => {
    for (const [tab, row] of [["maps", "set-basemap"], ["workflows", "set-minimap"], ["publishing", "set-export-width"]] as const) {
      expect(open(`/settings/${tab}`)).toEqual({ tab, anchor: null, address: `/settings/${tab}`, replace: false });
      expect(open(`/settings/${tab}`, `#${row}`)).toEqual({ tab, anchor: row, address: `/settings/${tab}#${row}`, replace: false });
      expect(open(`/settings/${tab}`, "", false)).toEqual({ tab: "account", anchor: null, address: "/settings/account", replace: true });
      expect(open(`/settings/${tab}`, `#${row}`, false)).toEqual({ tab: "account", anchor: null, address: "/settings/account", replace: true });
      // The bare address reopens one remembered only for the person who may see it.
      expect(open("/settings", "", true, tab)).toEqual({ tab, anchor: null, address: `/settings/${tab}`, replace: true });
      expect(open("/settings", "", false, tab)).toMatchObject({ tab: "account", address: "/settings/account" });
    }
  });

  it("opens Appearance for every signed-in person, each of its rows at its own address", () => {
    for (const admin of [true, false]) {
      expect(open("/settings/appearance", "", admin)).toEqual({ tab: "appearance", anchor: null, address: "/settings/appearance", replace: false });
      expect(open("/settings/appearance", "#set-side-menu", admin)).toEqual({
        tab: "appearance", anchor: "set-side-menu", address: "/settings/appearance#set-side-menu", replace: false,
      });
    }
  });

  it("lands the three shipped fragment links where they did", () => {
    expect(open("/settings", "#account", false)).toEqual({ tab: "account", anchor: "account", address: "/settings/account#account", replace: true });
    expect(open("/settings", "#password", false)).toEqual({ tab: "account", anchor: "password", address: "/settings/account#password", replace: true });
    expect(open("/settings", "#tokens-heading", false)).toEqual({
      tab: "tokens", anchor: "tokens-heading", address: "/settings/tokens#tokens-heading", replace: true,
    });
  });

  it("lands a shipped fragment on its tab even when another tab was open last", () => {
    expect(open("/settings", "#password", true, "limits")).toMatchObject({ tab: "account", anchor: "password" });
  });

  it("opens the bare address on the tab last open in this session, else Account", () => {
    expect(open("/settings", "", true, "limits")).toEqual({ tab: "limits", anchor: null, address: "/settings/limits", replace: true });
    expect(open("/settings", "", true, null)).toEqual({ tab: "account", anchor: null, address: "/settings/account", replace: true });
    expect(open("/settings/", "", false, "general")).toMatchObject({ tab: "general", replace: true });
  });

  it("never reopens a remembered tab the person cannot see, or one that no longer exists", () => {
    expect(open("/settings", "", false, "limits")).toMatchObject({ tab: "account", address: "/settings/account" });
    expect(open("/settings", "", true, "ai")).toMatchObject({ tab: "account", address: "/settings/account" });
  });

  it("keeps only a fragment that can name a row", () => {
    expect(open("/settings/limits", "#")).toMatchObject({ anchor: null, address: "/settings/limits", replace: true });
    expect(open("/settings/limits", "#a b\"c")).toMatchObject({ anchor: null, address: "/settings/limits", replace: true });
    expect(open("/settings/limits", "#set-query-time%20")).toMatchObject({ anchor: null });
  });
});
