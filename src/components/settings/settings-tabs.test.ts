import { describe, expect, it } from "vitest";
import { canOpenTab, settingsColumn } from "./settings-tabs";

const shape = (admin: boolean) => {
  const column = settingsColumn(admin);
  return { groups: column.groups.map(group => [group.label, group.tabs.map(tab => tab.label)]), users: column.users };
};

describe("the Settings column", () => {
  it("shows an admin You and Instance whole, with Users at its foot", () => {
    expect(shape(true)).toEqual({
      groups: [["You", ["Account", "Tokens"]], ["Instance", ["General", "Limits", "System"]]],
      users: true,
    });
  });

  it("shows a member Account, Tokens and General only, and no Users link", () => {
    expect(shape(false)).toEqual({
      groups: [["You", ["Account", "Tokens"]], ["Instance", ["General"]]],
      users: false,
    });
  });

  it("opens the admin-only tabs for an admin alone, and nothing it does not draw", () => {
    for (const id of ["account", "tokens", "general"]) {
      expect(canOpenTab(id, false)).toBe(true);
      expect(canOpenTab(id, true)).toBe(true);
    }
    for (const id of ["limits", "system"]) {
      expect(canOpenTab(id, false)).toBe(false);
      expect(canOpenTab(id, true)).toBe(true);
    }
    for (const id of ["appearance", "maps", "users", "", "Account"]) {
      expect(canOpenTab(id, true)).toBe(false);
    }
  });
});
