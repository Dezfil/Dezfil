import { privateStateOpen } from "../auth/private-state";

/**
 * The Settings tab last open in this browser session, so the bare
 * Settings address (the rail's gear) returns to it. A browser
 * convenience over served data, kept in the session's own store under
 * the account's private prefix, so signing out or another account
 * signing in forgets it. A refused store simply remembers nothing.
 */
export const LAST_TAB_KEY = "dezfil:settings:tab";

export function readLastTab(): string | null {
  if (!privateStateOpen()) return null;
  try { return globalThis.sessionStorage?.getItem(LAST_TAB_KEY) ?? null; } catch { return null; }
}

export function writeLastTab(tab: string): void {
  if (!privateStateOpen()) return;
  try { globalThis.sessionStorage?.setItem(LAST_TAB_KEY, tab); } catch { /* nothing remembered */ }
}
