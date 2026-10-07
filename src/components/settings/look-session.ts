import { onPrivateReset } from "../auth/private-state";
import type { Look } from "@/lib/look";
import { lookTab, shownLook, stampLook, type LookSend, type LookTab } from "./look-tab";

/**
 * The person's look while the workspace document lives: the Appearance
 * tab's cards and its tab-wide reset, made when the tab first reads the
 * look and kept here for the signed-in account rather than in the tab's
 * mount. The document's root follows what they show from here, so a write
 * still on its way when the tab is left settles on the root all the same:
 * the value the server accepted, or the kept one again on a refusal. A
 * tab mounted again carries on with the same writes, never a second queue.
 *
 * A change of account ends it before anything of the next account is
 * read: an answer arriving after that touches nothing.
 */
export interface LookSession extends LookTab {
  /** The account it belongs to, by its SQL name, which never changes. */
  readonly account: string | null;
}

let current: { readonly session: LookSession; readonly stop: () => void } | null = null;

onPrivateReset(() => endLookSession());

/** The account's session, if one is open in this document. */
export function lookSession(account: string | null): LookSession | null {
  return current && current.session.account === account ? current.session : null;
}

/** The account's session, opened over the look just read unless one is
 * open already; any other account's ends first. */
export function openLookSession(account: string | null, kept: Look, send: LookSend, root?: Element): LookSession {
  const open = lookSession(account);
  if (open) return open;
  endLookSession();
  const tab = lookTab(kept, send);
  const session: LookSession = { ...tab, account };
  const target = root ?? document.documentElement;
  const stamp = () => stampLook(target, shownLook(tab.units.map(unit => unit.snapshot)));
  const stops = tab.units.map(unit => unit.subscribe(stamp));
  stamp();
  current = { session, stop: () => { for (const stop of stops) stop(); } };
  return session;
}

/** Ends the open session: what it still has on its way changes nothing. */
export function endLookSession(): void {
  current?.stop();
  current = null;
}
