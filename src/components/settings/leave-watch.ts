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
 * - A step past the tab (a jump of several entries from the browser's
 *   history list, or a second Back while the question is open): the page
 *   takes it, so neither the private workspace nor the router hears it,
 *   and asks. Keep editing puts the tab's address back: to the extra
 *   entry, where the browser reports how far away it is, else as new
 *   entries, the tab's own with the router's state and the extra one on
 *   top. Discard hands the step to the private workspace, which ends the
 *   document at the address the browser shows.
 * - Reload and closing: the browser's own question.
 *
 * Moving within the tab (a row's fragment) never asks, and nothing asks,
 * is taken or is added while nothing is unsaved. The private workspace
 * ends the document on every Back and Forward a page neither keeps nor
 * takes; the watch tells it which steps stay on this tab and which it
 * takes.
 */

/** Marks the extra entry in its history state, with the watch it belongs to. */
const HOLD_KEY = "settingsHold";

/** The Navigation API's entries, where the browser reports them: a key a
 * replace keeps, and the entry's place in the session's history. */
interface NavigationEntryLike { readonly key: string; readonly index: number }
interface NavigationLike {
  readonly currentEntry: NavigationEntryLike | null;
  entries?(): readonly NavigationEntryLike[];
}

export interface LeaveWatchOptions {
  readonly guard: { holding(): boolean; subscribe(listener: () => void): () => void };
  /** Whether an address opens the tab on screen, so following it leaves nothing. */
  readonly staysOnTab: (url: URL) => boolean;
  /** Asks the person; true lets the tab go. */
  readonly ask: () => Promise<boolean>;
  /** Opens an address inside the app, as a new history entry. */
  readonly open: (address: string) => void;
  /** Ends the document at the address the browser shows: a step past the tab, let go. */
  readonly end: () => void;
}

export interface LeaveWatch {
  /** Opens an address inside the app, asking first when it leaves a tab
   * that holds; resolves whether it is on its way. */
  leave(address: string): Promise<boolean>;
  /** Whether the Back or Forward that just happened stays in the document. */
  keeps(): boolean;
  /** Whether the page takes the Back or Forward that just happened itself:
   * a step past the tab it holds, or its own step back to it. */
  takes(): boolean;
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
  /** The extra entry's key, where the browser reports one, which a
   * replace keeps. */
  let extraKey: string | null = null;
  /** The router's state on the tab's own entry, under the extra one, to
   * put that entry back as it was. */
  let tabState: unknown = null;
  /** The address of an extra entry being taken away, until its step has passed every listener. */
  let dropped: string | null = null;
  /** The extra entry the page is stepping back to after a step past the tab. */
  let returning: string | null = null;
  /** Steps the page took itself: taking the extra entry away, or going back once more on Discard. */
  let dropping = 0, passing = 0;
  let afterDrop: (() => void) | null = null;
  let asking = false, released = false, stopped = false;

  const currentKey = () => navigation?.currentEntry?.key ?? null;
  const onExtra = () => {
    const state: unknown = win.history.state;
    if (typeof state === "object" && state !== null && (state as Record<string, unknown>)[HOLD_KEY] === token) return true;
    return extraKey !== null && currentKey() === extraKey;
  };
  const leaving = (url: URL) => guard.holding() && !options.staysOnTab(url);
  const onTab = () => options.staysOnTab(new URL(win.location.href));
  /** The page's own step back onto its extra entry. */
  const returned = () => returning !== null && currentKey() === returning;
  /** A step past the tab while it holds, the page's own steps aside. */
  const pastTab = () => !stopped && !released && !passing && extra !== null && guard.holding() && !onTab();

  /** Put the extra entry on top of the one on screen, unless it is the one on screen. */
  function hold() {
    if (!onExtra()) {
      tabState = win.history.state;
      win.history.pushState({ [HOLD_KEY]: token }, "");
      extraKey = currentKey();
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
  /** How far the extra entry is from the one on screen, where the browser says. */
  function distanceTo(key: string | null): number | null {
    const here = navigation?.currentEntry;
    if (!key || !here || typeof navigation?.entries !== "function") return null;
    const target = navigation.entries().find(entry => entry.key === key);
    return target ? target.index - here.index : null;
  }
  /** Back to the tab after Keep editing on a step past it. */
  function putBack() {
    const address = extra;
    if (address === null) { letGo(); return; }
    const distance = distanceTo(extraKey);
    if (distance) { returning = extraKey; win.history.go(distance); return; }
    // No distance to go by: the tab's own entry again, as the router left
    // it so it has nothing to restore, and the extra entry on top.
    win.history.pushState(tabState, "", address);
    extraKey = null;
    hold();
  }
  /** The step past the tab goes on: the document ends where it went, and
   * the browser's own question stays quiet, since this page asked. */
  function letGo() {
    released = true;
    extra = null;
    options.end();
  }
  /** The answer to a Back or Forward, wherever it has left the browser. */
  function settle(discard: boolean) {
    if (stopped) return;
    if (!onTab()) {
      if (discard || !guard.holding()) letGo(); else putBack();
      return;
    }
    if (!guard.holding()) return;
    if (!discard) { hold(); return; }
    released = true; passing += 1;
    // Forward while it asked put the extra entry back on screen: past it too.
    if (onExtra()) win.history.go(-2); else win.history.back();
    extra = null;
  }
  function question(answer: (discard: boolean) => void) {
    asking = true;
    void options.ask().then(discard => { asking = false; answer(discard); }, () => { asking = false; });
  }

  const onGuard = () => {
    if (stopped) return;
    if (guard.holding()) { if (extra === null && !dropping && !passing && onTab()) hold(); }
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
    // A step past the tab while it asked: the answer is for that step.
    question(discard => { if (!onTab()) settle(discard); else if (discard) go(addressOf(url)); });
  };

  /** Heard before the router: the steps the page takes go no further. */
  const onTake = (event: Event) => {
    if (returned()) {
      // Back on the extra entry: the router never heard the step out, so it hears nothing of this one.
      returning = null;
      event.stopImmediatePropagation();
      extra = win.location.href;
      released = false;
      return;
    }
    if (!pastTab()) return;
    event.stopImmediatePropagation();
    // A question already open answers for this step too.
    if (!asking) question(settle);
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
    // Past the tab: taken before it got here, unless the page had let the tab go.
    if (!options.staysOnTab(arrival)) { extra = null; return; }
    // Another row of the tab: nothing to leave; the extra entry goes on top of it.
    if (arrival.href !== extra) { hold(); return; }
    // Back from the extra entry: the same page, and the person meant to leave.
    if (asking) return;
    question(settle);
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

  // The router writes its own state over the entry on screen when it
  // replaces the same address (clicking the tab already open does), which
  // would wipe the mark that names the extra entry: saving could not take
  // the entry away, and Back would land on the same tab. While the watch
  // runs, a replace of the extra entry keeps the mark, whether or not the
  // browser reports entry keys. The router calls the window's replace at
  // the time it replaces, so it goes through this one.
  const history = win.history;
  const replaceState = typeof history.replaceState === "function" ? history.replaceState : null;
  const keepMark: History["replaceState"] = (data, unused, url) => {
    const next = !stopped && onExtra()
      ? { ...(typeof data === "object" && data !== null ? data : {}), [HOLD_KEY]: token }
      : data;
    replaceState!.call(history, next, unused, url);
  };
  if (replaceState) history.replaceState = keepMark;

  const unsubscribe = guard.subscribe(onGuard);
  doc.addEventListener("click", onClick, true);
  doc.addEventListener("keydown", onTouch, true);
  doc.addEventListener("pointerdown", onTouch, true);
  win.addEventListener("popstate", onTake, true);
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
      return new Promise(resolve => question(discard => {
        // A step past the tab while it asked: the answer is for that step.
        const here = onTab();
        if (!here) settle(discard); else if (discard) go(address);
        resolve(here && discard);
      }));
    },
    keeps() {
      const href = win.location.href;
      if (dropped !== null && href === dropped) return true;
      if (passing || extra === null || !guard.holding()) return false;
      return options.staysOnTab(new URL(href));
    },
    takes() {
      return returned() || pastTab();
    },
    stop() {
      stopped = true;
      // Put the replace back unless something wrapped it since; this one marks nothing once stopped.
      if (replaceState && history.replaceState === keepMark) history.replaceState = replaceState;
      unsubscribe();
      doc.removeEventListener("click", onClick, true);
      doc.removeEventListener("keydown", onTouch, true);
      doc.removeEventListener("pointerdown", onTouch, true);
      win.removeEventListener("popstate", onTake, true);
      win.removeEventListener("popstate", onPop);
      win.removeEventListener("beforeunload", onUnload);
    },
  };
}
