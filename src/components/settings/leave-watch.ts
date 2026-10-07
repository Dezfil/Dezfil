/**
 * Leaving the Settings tab on screen while it holds unsaved text.
 *
 * The router cannot cancel a navigation, and a browser's Back has already
 * moved when the page hears of it, so the page asks before anything can
 * leave:
 *
 * - A link (the tab column, the rail, a link in a card) or a search hit:
 *   its click is held, the question asked, and the address opened only
 *   when the person lets the tab go.
 * - Back: while the tab holds, one extra history entry sits on top of it
 *   at the same address, added when the text first differs and taken away
 *   unseen once it is saved or cancelled. Back then lands on the same page
 *   and moves nothing, and the question is asked there. Keep editing puts
 *   the extra entry back; Discard goes back once more, and the private
 *   workspace ends the document on that step before the router hears it.
 *   Adding the entry drops whatever lay ahead, so Forward cannot leave
 *   while the tab holds.
 * - Reload and closing: the browser's own question.
 *
 * Moving within the tab (a row's fragment) never asks, and nothing asks
 * or is added while nothing is unsaved. The private workspace ends the
 * document on every Back and Forward; the watch tells it which steps stay
 * on this tab, so those keep the text. A jump of several entries from the
 * browser's history list past the tab is not held here: the workspace
 * reloads at its arrival, and that reload asks the browser's question.
 */

/** Marks the extra entry in its history state, with the watch it belongs to. */
const HOLD_KEY = "settingsHold";

/** The Navigation API's entry on screen, where the browser reports it. */
interface NavigationLike { readonly currentEntry: { readonly key: string } | null }

export interface LeaveWatchOptions {
  readonly guard: { holding(): boolean; subscribe(listener: () => void): () => void };
  /** Whether an address opens the tab on screen, so following it leaves nothing. */
  readonly staysOnTab: (url: URL) => boolean;
  /** Asks the person; true lets the tab go. */
  readonly ask: () => Promise<boolean>;
  /** Opens an address inside the app, as a new history entry. */
  readonly open: (address: string) => void;
}

export interface LeaveWatch {
  /** Opens an address inside the app, asking first when it leaves a tab
   * that holds; resolves whether it is on its way. */
  leave(address: string): Promise<boolean>;
  /** Whether the Back or Forward that just happened stays in the document. */
  keeps(): boolean;
  stop(): void;
}

function addressOf(url: URL): string {
  return url.pathname + url.search + url.hash;
}

/** Start watching the tab on screen. */
export function watchLeaving(win: Window, doc: Document, options: LeaveWatchOptions): LeaveWatch {
  const { guard } = options;
  const token = Math.random().toString(36).slice(2);
  const navigation = (win as unknown as { navigation?: NavigationLike }).navigation ?? null;
  /** The address of the extra entry while the tab holds. */
  let extra: string | null = null;
  /** The extra entry's key, where the browser reports one: the router
   * rewrites an entry's state when it replaces the same address, and the
   * key outlives that. */
  let extraKey: string | null = null;
  /** The address of an extra entry being taken away, until its step has passed every listener. */
  let dropped: string | null = null;
  /** Steps the page took itself: taking the extra entry away, or going back once more on Discard. */
  let dropping = 0, passing = 0;
  let afterDrop: (() => void) | null = null;
  let asking = false, released = false, stopped = false;

  const onExtra = () => {
    const state: unknown = win.history.state;
    if (typeof state === "object" && state !== null && (state as Record<string, unknown>)[HOLD_KEY] === token) return true;
    return extraKey !== null && navigation?.currentEntry?.key === extraKey;
  };
  const leaving = (url: URL) => guard.holding() && !options.staysOnTab(url);
  const onTab = () => options.staysOnTab(new URL(win.location.href));

  /** Put the extra entry on top of the one on screen, unless it is the one on screen. */
  function hold() {
    if (!onExtra()) {
      win.history.pushState({ [HOLD_KEY]: token }, "");
      extraKey = navigation?.currentEntry?.key ?? null;
    }
    extra = win.location.href;
    released = false;
  }
  /** Take the extra entry away when it is the one on screen, then go on. */
  function drop(then: (() => void) | null) {
    const was = extra;
    extra = null;
    if (was === null || !onExtra()) { then?.(); return; }
    dropped = was; dropping += 1; afterDrop = then;
    win.history.back();
  }
  /** Open an address once the extra entry is gone. */
  function go(address: string) {
    if (dropping) {
      const before = afterDrop;
      afterDrop = () => { before?.(); options.open(address); };
      return;
    }
    drop(() => options.open(address));
  }
  function question(answer: (discard: boolean) => void) {
    asking = true;
    void options.ask().then(discard => { asking = false; answer(discard); }, () => { asking = false; });
  }

  const onGuard = () => {
    if (stopped) return;
    if (guard.holding()) { if (extra === null && !dropping && !passing) hold(); }
    else { released = false; if (extra !== null) drop(null); }
  };

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
    if (url.origin !== win.location.origin) return;
    // The extra entry is on its way out: the link follows once it is gone.
    if (dropping) { event.preventDefault(); go(addressOf(url)); return; }
    if (!leaving(url)) return;
    event.preventDefault();
    if (asking) return;
    question(discard => { if (discard) go(addressOf(url)); });
  };

  const onPop = () => {
    if (passing) { passing -= 1; return; }
    if (dropping) {
      dropping -= 1;
      if (dropping) return;
      const then = afterDrop;
      afterDrop = null;
      // Every listener hears this step before the page moves on.
      setTimeout(() => {
        dropped = null;
        if (stopped) return;
        if (then) then();
        else if (guard.holding() && !passing) hold();
      }, 0);
      return;
    }
    if (extra === null || !guard.holding() || onExtra()) return;
    const arrival = new URL(win.location.href);
    // Past the tab: the router follows and the workspace's reload asks.
    if (!options.staysOnTab(arrival)) { extra = null; return; }
    // Another row of the tab: nothing to leave; the extra entry goes on top of it.
    if (arrival.href !== extra) { hold(); return; }
    // Back from the extra entry: the same page, and the person meant to leave.
    if (asking) return;
    question(discard => {
      if (stopped || !guard.holding() || !onTab()) return;
      if (!discard) { hold(); return; }
      released = true; passing += 1;
      // Forward while it asked put the extra entry back on screen: past it too.
      if (onExtra()) win.history.go(-2); else win.history.back();
      extra = null;
    });
  };

  const onUnload = (event: BeforeUnloadEvent) => {
    if (released || !guard.holding()) return;
    event.preventDefault();
    // Older browsers ask only when this is set.
    event.returnValue = "";
  };

  /** A Discard whose Back went nowhere (the tab's first page): the next
   * touch takes the tab up again. */
  const onTouch = () => {
    if (!released) return;
    released = false; passing = 0;
    if (guard.holding() && extra === null) hold();
  };

  const unsubscribe = guard.subscribe(onGuard);
  doc.addEventListener("click", onClick, true);
  doc.addEventListener("keydown", onTouch, true);
  doc.addEventListener("pointerdown", onTouch, true);
  win.addEventListener("popstate", onPop);
  win.addEventListener("beforeunload", onUnload);
  onGuard();

  return {
    leave(address) {
      const url = new URL(address, win.location.href);
      if (!leaving(url)) {
        if (dropping) go(address); else options.open(address);
        return Promise.resolve(true);
      }
      if (asking) return Promise.resolve(false);
      return new Promise(resolve => question(discard => { if (discard) go(address); resolve(discard); }));
    },
    keeps() {
      const href = win.location.href;
      if (dropped !== null && href === dropped) return true;
      if (passing || extra === null || !guard.holding()) return false;
      return options.staysOnTab(new URL(href));
    },
    stop() {
      stopped = true;
      unsubscribe();
      doc.removeEventListener("click", onClick, true);
      doc.removeEventListener("keydown", onTouch, true);
      doc.removeEventListener("pointerdown", onTouch, true);
      win.removeEventListener("popstate", onPop);
      win.removeEventListener("beforeunload", onUnload);
    },
  };
}
