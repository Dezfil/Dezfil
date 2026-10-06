import { canOpenTab, DEFAULT_TAB, type SettingsTabId } from "./settings-tabs";

/**
 * The Settings page's addresses. Each tab is a path under /settings and
 * each row a fragment inside it, so the browser's own history carries a
 * tab change and back and forward return to the tab left. The bare
 * address reopens the tab last open in this browser session, and the
 * three fragments links have always pointed at keep landing.
 */

export const SETTINGS_PATH = "/settings";

/** The fragments the page answered before it had tabs: the account card,
 * the password section (opened) and the tokens heading. */
const SHIPPED_FRAGMENTS: Readonly<Record<string, readonly [SettingsTabId, string]>> = {
  account: ["account", "account"],
  password: ["account", "password"],
  "tokens-heading": ["tokens", "tokens-heading"],
};

/** A fragment names a row only when it could be an element's id here. */
const ROW_ID = /^[A-Za-z][\w-]*$/;

export function tabAddress(tab: SettingsTabId, row?: string | null): string {
  return `${SETTINGS_PATH}/${tab}${row ? `#${row}` : ""}`;
}

export interface SettingsLocation {
  readonly tab: SettingsTabId;
  /** The element to bring into view and mark, when the address names one. */
  readonly anchor: string | null;
  /** The address the page shows for this location. */
  readonly address: string;
  /** The browser shows another address and should be brought to this one. */
  readonly replace: boolean;
}

function fragment(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  return ROW_ID.test(raw) ? raw : null;
}

/** Where an address opens for this person. */
export function resolveSettingsAddress(input: {
  pathname: string;
  hash: string;
  admin: boolean;
  /** The tab this browser session last showed, as remembered. */
  lastTab: string | null;
}): SettingsLocation {
  const { pathname, hash, admin, lastTab } = input;
  const segments = pathname.startsWith(SETTINGS_PATH)
    ? pathname.slice(SETTINGS_PATH.length).split("/").filter(Boolean)
    : [];
  const row = fragment(hash);
  let tab: SettingsTabId = DEFAULT_TAB, anchor: string | null = null;
  if (segments.length === 0) {
    const shipped = row ? SHIPPED_FRAGMENTS[row] : undefined;
    if (shipped) [tab, anchor] = shipped;
    else {
      tab = lastTab && canOpenTab(lastTab, admin) ? lastTab : DEFAULT_TAB;
      anchor = row;
    }
  } else if (segments.length === 1 && canOpenTab(segments[0], admin)) {
    tab = segments[0];
    anchor = row;
  }
  const address = tabAddress(tab, anchor);
  return { tab, anchor, address, replace: address !== pathname + hash };
}
