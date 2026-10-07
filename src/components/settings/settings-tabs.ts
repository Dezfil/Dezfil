/**
 * The Settings page's tabs, in the column's order. Labels and groups are
 * the frame's; each tab's content is its own. A tab marked for admins is
 * drawn only for an admin, and its address opens Account for anyone
 * else, so a member never triggers a read only an admin may make.
 */

export type SettingsGroup = "you" | "instance";
export type SettingsTabId = "account" | "tokens" | "appearance" | "general" | "limits" | "system";

export interface SettingsTab {
  readonly id: SettingsTabId;
  readonly label: string;
  readonly group: SettingsGroup;
  readonly adminOnly: boolean;
}

export const SETTINGS_TABS: readonly SettingsTab[] = [
  { id: "account", label: "Account", group: "you", adminOnly: false },
  { id: "tokens", label: "Tokens", group: "you", adminOnly: false },
  { id: "appearance", label: "Appearance", group: "you", adminOnly: false },
  { id: "general", label: "General", group: "instance", adminOnly: false },
  { id: "limits", label: "Limits", group: "instance", adminOnly: true },
  { id: "system", label: "System", group: "instance", adminOnly: true },
];

export const SETTINGS_GROUPS: readonly { readonly id: SettingsGroup; readonly label: string }[] = [
  { id: "you", label: "You" },
  { id: "instance", label: "Instance" },
];

/** Where an address that names no tab the person can see lands. */
export const DEFAULT_TAB: SettingsTabId = "account";

/** The tab with this id, when there is one. */
export function settingsTab(id: string): SettingsTab | undefined {
  return SETTINGS_TABS.find(tab => tab.id === id);
}

/** Whether this person may open the tab: every tab for an admin, the
 * unmarked ones for everyone else. Unknown ids are never openable. */
export function canOpenTab(id: string, admin: boolean): id is SettingsTabId {
  const tab = settingsTab(id);
  return !!tab && (admin || !tab.adminOnly);
}

/** The column as this person sees it: each group with its visible tabs,
 * and whether the Users link closes it. */
export function settingsColumn(admin: boolean) {
  return {
    groups: SETTINGS_GROUPS.map(group => ({
      ...group,
      tabs: SETTINGS_TABS.filter(tab => tab.group === group.id && (admin || !tab.adminOnly)),
    })).filter(group => group.tabs.length > 0),
    users: admin,
  };
}
