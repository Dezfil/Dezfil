import { ACCOUNT_CHANGED_EVENT, ACCOUNT_STORAGE_KEY, closePrivateState, openPrivateState } from "./private-state";
import { privateFetch } from "./private-fetch";
import { endTraversalsWith, traversalKept, traversalTaker } from "./kept-traversals";

/** How long a Back or Forward held for the session read keeps the page
 * on screen before hiding it: a session read on the same server answers
 * well within it, so the page is hidden only when the read is slow. */
export const TRAVERSAL_GRACE_MS = 120;

/** A document belongs to one account. A change ends that document, so Next's
 * route cache, React state, module caches and pending downloads cannot become
 * another person's workspace. No private children mount before the handshake. */
export function watchPrivateWorkspace(accountId: string, ready: (value: boolean) => void): () => void {
  const transport = window.fetch.bind(window);
  const lifetime = new AbortController();
  let stopped = false, checking = 0, initialized = false;
  /** Back and Forward steps held until the session read agrees, each handing itself on. */
  let held: (() => void)[] = [];
  let grace: ReturnType<typeof setTimeout> | null = null;
  /** A held step being handed on to the window's other listeners. */
  let replaying = false;
  const conceal = () => { document.documentElement.hidden = true; };
  const release = () => {
    held = [];
    if (grace) { clearTimeout(grace); grace = null; }
  };
  const reload = () => {
    if (stopped) return;
    stopped = true; checking++; release();
    conceal(); document.title = "Dezfil"; lifetime.abort(); closePrivateState(); ready(false);
    window.location.replace(window.location.href);
  };
  /** A Back or Forward nobody keeps, or one a page let go: the document
   * reloads at the address the browser shows. Nothing is torn down first,
   * because a page holding unsaved work may have the browser ask before
   * leaving, and a person who answers Stay keeps the page as it was and
   * can still step again. The page hides as the document goes (pagehide). */
  const traverse = () => {
    if (stopped) return;
    window.location.replace(window.location.href);
  };
  const guarded =privateFetch(accountId, window.location.origin, transport, lifetime.signal, reload);
  window.fetch = guarded;
  /** Read the session; a changed or ended account ends the document, a
   * matching one shows it and hands on the steps held for it. `hide`
   * keeps the page hidden until the read agrees. */
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
      const steps = held;
      release();
      document.documentElement.hidden = false;
      for (const step of steps) step();
    } catch { if (!stopped && version === checking) reload(); }
  };
  /** A kept step, handed to the window's other listeners (the router's
   * first) with the state it arrived with. */
  const replay = (step: Event) => {
    const state: unknown = (step as PopStateEvent).state ?? null;
    const again = typeof PopStateEvent === "function" ? new PopStateEvent("popstate", { state }) : Object.assign(new Event("popstate"), { state });
    replaying = true;
    try { window.dispatchEvent(again); } finally { replaying = false; }
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
  // place a step can be stopped before the router restores a route.
  //
  // Every step is stopped here. One nobody keeps or takes reloads the
  // document, so the router never starts restoring a route the reload
  // throws away. One kept or taken stays in this document, so it waits
  // for a fresh read of the session, as on focus: when the read names
  // this document's account, a kept step goes on to the router and the
  // rest, and a taken one to the page that takes it; any other answer,
  // or none, ends the document, and the step goes nowhere. The page stays
  // shown while the read is quick and is hidden if it is not. A page that
  // took a step and lets it go on hands it back to the reload.
  const popstate = (event: Event) => {
    if (replaying) return;
    const take = traversalTaker();
    const kept = !take && traversalKept();
    event.stopImmediatePropagation();
    if (!take && !kept) { traverse(); return; }
    held.push(take ? () => take(event) : () => replay(event));
    grace ??= setTimeout(() => { grace = null; if (held.length && !stopped) conceal(); }, TRAVERSAL_GRACE_MS);
    void check(false);
  };
  const withdraw = endTraversalsWith(traverse);
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
    stopped = true; checking++; lifetime.abort(); release();
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
