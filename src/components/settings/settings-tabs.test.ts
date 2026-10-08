import { describe, expect, it } from "vitest";
import { canOpenTab, settingsColumn } from "./settings-tabs";

const shape = (admin: boolean) => {
  const column = settingsColumn(admin);
  return { groups: column.groups.map(group => [group.label, group.tabs.map(tab => tab.label)]), users: column.users };
};

describe("the Settings column", () => {
  it("shows an admin You and Instance whole, what new things start with between General and Limits, Security between Limits and System, with Users at its foot", () => {
    expect(shape(true)).toEqual({
      groups: [
        ["You", ["Account", "Tokens", "Appearance"]],
        ["Instance", ["General", "Maps", "Workflows & SQL", "Publishing", "Limits", "Security", "System"]],
      ],
      users: true,
    });
  });

  it("shows a member Account, Tokens, Appearance and General only, and no Users link", () => {
    expect(shape(false)).toEqual({
      groups: [["You", ["Account", "Tokens", "Appearance"]], ["Instance", ["General"]]],
      users: false,
    });
  });

  it("opens the admin-only tabs for an admin alone, and nothing it does not draw", () => {
    for (const id of ["account", "tokens", "appearance", "general"]) {
      expect(canOpenTab(id, false)).toBe(true);
      expect(canOpenTab(id, true)).toBe(true);
    }
    for (const id of ["maps", "workflows", "publishing", "limits", "security", "system"]) {
      expect(canOpenTab(id, false)).toBe(false);
      expect(canOpenTab(id, true)).toBe(true);
    }
    // The tabs the page does not build, and spellings no tab has.
    for (const id of ["ai", "libraries", "data", "ai-providers", "users", "", "Account", "Maps", "Security", "workflows-sql"]) {
      expect(canOpenTab(id, true)).toBe(false);
    }
  });
});
