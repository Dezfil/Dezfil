import { ACCOUNT_CHANGED_EVENT, ACCOUNT_STORAGE_KEY, closePrivateState, openPrivateState } from "./private-state";
import { privateFetch } from "./private-fetch";
import { endTraversalsWith, traversalKept, traversalTaker } from "./kept-traversals";

/** A document belongs to one account. A change ends that document, so Next's
 * route cache, React state, module caches and pending downloads cannot become
 * another person's workspace. No private children mount before the handshake. */
export function watchPrivateWorkspace(accountId: string, ready: (value: boolean) => void): () => void {
  const transport = window.fetch.bind(window);
  const lifetime = new AbortController();
  let stopped = false, checking = 0, initialized = false;
  const conceal = () => { document.documentElement.hidden = true; };
  const reload = () => {
    if (stopped) return;
    stopped = true; checking++;
    conceal(); document.title = "Dezfil"; lifetime.abort(); closePrivateState(); ready(false);
    window.location.replace(window.location.href);
  };
  const guarded = privateFetch(accountId, window.location.origin, transport, lifetime.signal, reload);
  window.fetch = guarded;
  /** Read the session; a changed or ended account ends the document.
   * `hide` keeps the page hidden until the read agrees. */
  const check = async (hide = true) => {
    if (stopped) return;
    const version = ++checking;
    if (hide) conceal();
    try {
      const response = await transport("/api/auth/session", { cache: "no-store", signal: lifetime.signal });
      const body = response.ok ? await response.json() : null;
      if (stopped || version !== checking) return;
      if (body?.account?.id !== accountId) { reload(); return; }
      if (!initialized) { openPrivateState(accountId); initialized = true; ready(true); }
      document.documentElement.hidden = false;
    } catch { if (!stopped && version === checking) reload(); }
  };
  const visibility = () => { if (document.visibilityState === "hidden") conceal(); else void check(); };
  const storage = (event: StorageEvent) => { if (event.key === ACCOUNT_STORAGE_KEY || event.key === null) reload(); };
  const pagehide = () => { conceal(); document.title = "Dezfil"; lifetime.abort(); };
  const pageshow = (event: PageTransitionEvent) => { if (event.persisted) reload(); };
  const focus = () => { void check(); };
  // A Back or Forward restores a cached route, unless the page on screen
  // keeps it on what it already shows, or takes it itself to ask first.
  // A browser runs a window's popstate listeners in the order they were
  // added, capture or not; this one is added before the router's (the
  // workspace's effect runs before the app router's), so it is the one
  // place a step can be stopped before the router restores a route. A
  // step nobody keeps or takes ends the document, stopped here, so the
  // router never starts restoring a route the reload throws away. A step
  // a page takes is stopped here too and handed to the page; a page that
  // took a step and lets it go on hands it back to the reload.
  //
  // A step kept or taken stays in this document, so the session is read
  // for it as on focus, and a changed or ended account ends the document
  // as any other step would. Such a step brings nothing onto the screen
  // that was not there a moment before, so the page stays shown while
  // the session is read.
  const popstate = (event: Event) => {
    const take = traversalTaker();
    if (take) { event.stopImmediatePropagation(); void check(false); take(event); return; }
    if (traversalKept()) { void check(false); return; }
    event.stopImmediatePropagation();
    reload();
  };
  const withdraw = endTraversalsWith(reload);
  const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(ACCOUNT_CHANGED_EVENT);
  channel?.addEventListener("message", reload);
  window.addEventListener("storage", storage);
  window.addEventListener(ACCOUNT_CHANGED_EVENT, reload);
  window.addEventListener("focus", focus);
  window.addEventListener("pagehide", pagehide);
  window.addEventListener("pageshow", pageshow);
  window.addEventListener("popstate", popstate, true);
  document.addEventListener("visibilitychange", visibility);
  void check();
  return () => {
    stopped = true; checking++; lifetime.abort();
    withdraw();
    if (window.fetch === guarded) window.fetch = transport;
    window.removeEventListener("storage", storage);
    window.removeEventListener(ACCOUNT_CHANGED_EVENT, reload);
    window.removeEventListener("focus", focus);
    window.removeEventListener("pagehide", pagehide);
    window.removeEventListener("pageshow", pageshow);
    window.removeEventListener("popstate", popstate, true);
    document.removeEventListener("visibilitychange", visibility);
    channel?.close();
  };
}
