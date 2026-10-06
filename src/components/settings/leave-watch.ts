/**
 * Leaving the Settings tab on screen while it holds unsaved text.
 *
 * The router cannot cancel a navigation, so the page watches the ways out
 * itself, before the router sees them:
 *
 * - A link (the tab column, the rail, a link in a card): its click is
 *   held, the question asked, and the link followed only when the person
 *   lets the tab go.
 * - Back and forward: the browser has already moved when it says so. The
 *   router is kept from following, the address is put back by traversing
 *   the same distance the other way, the question asked, and the original
 *   traversal made again when the person lets the tab go. The distance
 *   comes from the history entries' positions; a browser that does not
 *   report them gets the address back as a new entry instead.
 * - Reload and closing: the browser's own question.
 *
 * Moving within the tab (a row's fragment) never asks, and nothing asks
 * while nothing is unsaved.
 */

interface NavigationLike {
  readonly currentEntry: { readonly index: number } | null;
  addEventListener(type: "currententrychange", listener: () => void): void;
  removeEventListener(type: "currententrychange", listener: () => void): void;
}

export interface LeaveWatchOptions {
  readonly guard: { holding(): boolean };
  /** Whether an address opens the tab on screen, so following it leaves nothing. */
  readonly staysOnTab: (url: URL) => boolean;
  /** The address of the tab on screen. */
  readonly here: () => string;
  /** Asks the person; true lets the tab go. */
  readonly ask: () => Promise<boolean>;
  /** Opens an address inside the app, as a new history entry. */
  readonly open: (address: string) => void;
}

function addressOf(url: URL): string {
  return url.pathname + url.search + url.hash;
}

/** Start watching; the returned function stops. */
export function watchLeaving(win: Window, doc: Document, options: LeaveWatchOptions): () => void {
  const navigation = (win as unknown as { navigation?: NavigationLike }).navigation ?? null;
  // The positions of the entry on screen and of the one before it. Kept
  // as numbers, since a replaced entry no longer reports where it was.
  let current = navigation?.currentEntry?.index ?? null, previous = current;
  const onEntry = () => { previous = current; current = navigation?.currentEntry?.index ?? null; };
  /** Popstates the page caused: putting the address back, letting the tab go. */
  let restoring = 0, passing = 0;
  let asking = false;

  const leaving = (url: URL) => options.guard.holding() && !options.staysOnTab(url);
  /** The distance just travelled, when the browser reports positions. */
  const travelled = (): number | null => {
    const arrival = navigation?.currentEntry?.index;
    if (arrival === undefined || arrival < 0) return null;
    // The entry change is reported before the popstate; tolerate either order.
    const left = current === arrival ? previous : current;
    return left === null || left < 0 || left === arrival ? null : arrival - left;
  };
  function question(go: (discard: boolean) => void) {
    asking = true;
    void options.ask().then(discard => { asking = false; go(discard); }, () => { asking = false; });
  }

  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || (event.button ?? 0) !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target as { closest?: (selector: string) => Element | null } | null;
    const anchor = typeof target?.closest === "function" ? target.closest("a[href]") : null;
    if (!anchor || anchor.hasAttribute("download")) return;
    const frame = anchor.getAttribute("target");
    if (frame && frame !== "_self") return;
    let url: URL;
    try { url = new URL(anchor.getAttribute("href") ?? "", win.location.href); } catch { return; }
    // Another site is a page load: the browser asks on its own.
    if (url.origin !== win.location.origin || !leaving(url)) return;
    event.preventDefault();
    if (asking) return;
    question(discard => { if (discard) options.open(addressOf(url)); });
  };

  const onPop = (event: PopStateEvent) => {
    if (passing) { passing -= 1; return; }
    if (restoring) { restoring -= 1; event.stopImmediatePropagation(); return; }
    const arrival = new URL(win.location.href);
    if (!leaving(arrival)) return;
    event.stopImmediatePropagation();
    const distance = travelled();
    if (distance !== null) {
      restoring += 1;
      win.history.go(-distance);
    } else {
      options.open(options.here());
    }
    if (asking) return;
    question(discard => {
      if (!discard) return;
      if (distance !== null) { passing += 1; win.history.go(distance); }
      else options.open(addressOf(arrival));
    });
  };

  const onUnload = (event: BeforeUnloadEvent) => {
    if (!options.guard.holding()) return;
    event.preventDefault();
    // Older browsers ask only when this is set.
    event.returnValue = "";
  };

  doc.addEventListener("click", onClick, true);
  win.addEventListener("popstate", onPop, true);
  win.addEventListener("beforeunload", onUnload);
  navigation?.addEventListener("currententrychange", onEntry);
  return () => {
    doc.removeEventListener("click", onClick, true);
    win.removeEventListener("popstate", onPop, true);
    win.removeEventListener("beforeunload", onUnload);
    navigation?.removeEventListener("currententrychange", onEntry);
  };
}
