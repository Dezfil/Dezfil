import { ACCOUNT_CHANGED_EVENT, ACCOUNT_STORAGE_KEY, closePrivateState, openPrivateState } from "./private-state";
import { privateFetch } from "./private-fetch";
import { traversalKept } from "./kept-traversals";

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
  const check = async () => {
    if (stopped) return;
    const version = ++checking;
    conceal();
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
  // keeps it on what it already shows.
  const popstate = () => { if (!traversalKept()) reload(); };
  const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(ACCOUNT_CHANGED_EVENT);
  channel?.addEventListener("message", reload);
  window.addEventListener("storage", storage);
  window.addEventListener(ACCOUNT_CHANGED_EVENT, reload);
  window.addEventListener("focus", focus);
  window.addEventListener("pagehide", pagehide);
  window.addEventListener("pageshow", pageshow);
  window.addEventListener("popstate", popstate);
  document.addEventListener("visibilitychange", visibility);
  void check();
  return () => {
    stopped = true; checking++; lifetime.abort();
    if (window.fetch === guarded) window.fetch = transport;
    window.removeEventListener("storage", storage);
    window.removeEventListener(ACCOUNT_CHANGED_EVENT, reload);
    window.removeEventListener("focus", focus);
    window.removeEventListener("pagehide", pagehide);
    window.removeEventListener("pageshow", pageshow);
    window.removeEventListener("popstate", popstate);
    document.removeEventListener("visibilitychange", visibility);
    channel?.close();
  };
}
