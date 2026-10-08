"use client";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { Account } from "@/lib/metadata/accounts";
import { DISPLAY_NAME_EVENT } from "@/components/UserBadge";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { AccountCard } from "./AccountCard";
import { TokensCard } from "./TokensCard";
import { AppearanceTab } from "./AppearanceTab";
import { GeneralTab } from "./GeneralTab";
import { MapsTab } from "./MapsTab";
import { WorkflowsTab } from "./WorkflowsTab";
import { PublishingTab } from "./PublishingTab";
import { LimitsTab } from "./LimitsTab";
import { SecurityTab } from "./SecurityTab";
import { SystemTab } from "./SystemTab";
import { accountRequest, failureMessage } from "./api";
import { SettingsColumn } from "./SettingsColumn";
import { resolveSettingsAddress, SETTINGS_PATH, tabAddress } from "./settings-address";
import type { SettingsTabId } from "./settings-tabs";
import { readLastTab, writeLastTab } from "./last-tab";
import { DrawnContext, landOn, markOutside, PENDING_DELAY_MS, TabSlot, type TabSlotEvents } from "./settings-land";
import type { Pointer, SearchHit } from "./settings-search";
import { SearchField, SearchResults } from "./SettingsSearch";
import { useSettingsSearch } from "./use-settings-search";
import { LeaveGuard, type GuardMessage } from "./leave-guard";
import { watchLeaving, type LeaveWatch } from "./leave-watch";
import { keepTraversals, letTraversalGo, takeTraversals } from "@/components/auth/kept-traversals";
import { GuardContext, LeaveDialog } from "./settings-guard";
import { LiveContext, LiveValues } from "./live-values";
import styles from "./SettingsFrame.module.css";

interface Loaded { account: Account }
/** The tab on screen, the row its address names, and a count of visits
 * so a second visit to the same row lands again. */
interface Shown { tab: SettingsTabId; anchor: string | null; visit: number }
interface Asking { message: GuardMessage; settle: (discard: boolean) => void }
/** Where a search hit lands once its tab is on screen: a row, or a control outside the page. */
interface Landing { anchor: string | null; pointer: Pointer | null; seq: number }
/** The pane: the tab on screen, and the tab the address names while it
 * reads out of sight, before it takes the other's place. */
interface Pane { visible: TabSlot | null; incoming: TabSlot | null }

const inSettings = (pathname: string) => pathname === SETTINGS_PATH || pathname.startsWith(`${SETTINGS_PATH}/`);

/** The pane once the address names `tab`. A tab let go with unsaved text
 * (the person was asked) leaves the screen at once, as it always did. */
function toward(pane: Pane, tab: SettingsTabId, events: TabSlotEvents, letGo: boolean): Pane {
  if (pane.visible?.tab === tab) return pane.incoming ? { visible: pane.visible, incoming: null } : pane;
  const incoming = pane.incoming?.tab === tab ? pane.incoming : new TabSlot(tab, events);
  return { visible: letGo ? null : pane.visible, incoming };
}

/**
 * The Settings page: the heading, the tab column and the tab beside it.
 * One route serves every tab address and this frame stays mounted across
 * them, so a tab change is an address change it follows: it resolves the
 * address against the person's role, corrects the address the browser
 * shows when it names nothing this person can open, remembers the tab
 * for the session and lands on the row the fragment names. The column
 * moves at once; the tab on screen stays until the next one, mounted out
 * of sight, has read what it shows, then gives way to it in one step, or
 * after a moment to the next tab's own loading state. While a card
 * holds unsaved typed text, leaving the tab (the column, a link, back,
 * forward, a jump from the history list, reload, closing) asks first,
 * naming the cards. The search at
 * the column's head answers in the tab's place; a hit opens its tab and
 * marks its row, asking first as any leaving does.
 */
export function SettingsFrame() {
  const pathname = usePathname();
  const router = useRouter();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null), [attempt, setAttempt] = useState(0);
  const [shown, setShown] = useState<Shown | null>(null);
  const content = useRef<HTMLDivElement>(null);
  /** The address this frame just asked the router for: its arrival is not a new visit. */
  const echo = useRef<string | null>(null);
  const lastTab = useRef<SettingsTabId | null>(null);
  const [guard] = useState(() => new LeaveGuard());
  const [asking, setAsking] = useState<Asking | null>(null);
  const leaving = useRef<LeaveWatch | null>(null);
  /** What the watch reads between renders: the tab on screen, and the role. */
  const here = useRef<{ tab: SettingsTabId | null; admin: boolean }>({ tab: null, admin: false });
  const [live] = useState(() => new LiveValues());
  const search = useSettingsSearch(loaded?.account ?? null, live);
  const [landing, setLanding] = useState<Landing | null>(null);
  /** A row an address or a hit named, until its tab is on screen and has drawn it. */
  const pending = useRef<string | null>(null);
  /** A change of tab goes to the page's top once the new tab is on screen. */
  const toTop = useRef(false);
  const [pane, setPane] = useState<Pane>({ visible: null, incoming: null });
  /** Counts the rows drawn on screen, so a row named before it was drawn lands when it is. */
  const [drawnRows, setDrawnRows] = useState(0);
  const [events] = useState<TabSlotEvents>(() => ({
    // A tab ready out of sight takes the place of the one on screen, which goes in the same step.
    ready: slot => setPane(current => current.incoming === slot ? { visible: slot, incoming: null } : current),
    drawn: () => setDrawnRows(count => count + 1),
  }));
  /** Once the tab the address names is on screen: to the top after a change
   * of tab, then to the row named, once it is drawn. */
  const arrive = useEffectEvent(() => {
    if (!shown || pane.incoming || pane.visible?.tab !== shown.tab) return;
    if (toTop.current) {
      toTop.current = false;
      if (typeof window.scrollTo === "function") window.scrollTo(0, 0);
    }
    const anchor = pending.current;
    if (anchor && landOn(content.current, anchor)) pending.current = null;
  });
  const openAddress = useEffectEvent((address: string) => {
    router.push(address, inSettings(new URL(address, window.location.href).pathname) ? { scroll: false } : undefined);
  });

  useEffect(() => {
    const watch = watchLeaving(window, document, {
      guard,
      staysOnTab: url => {
        if (!here.current.tab) return true;
        if (!inSettings(url.pathname)) return false;
        return resolveSettingsAddress({ pathname: url.pathname, hash: url.hash, admin: here.current.admin, lastTab: readLastTab() }).tab === here.current.tab;
      },
      ask: () => new Promise<boolean>(settle => {
        const message = guard.message();
        if (message) setAsking({ message, settle }); else settle(true);
      }),
      open: address => openAddress(address),
      // A step past the tab, let go: the private workspace ends the document there, or the page reloads.
      end: () => { if (!letTraversalGo()) window.location.replace(window.location.href); },
    });
    leaving.current = watch;
    const letKeep = keepTraversals(watch.keeps), letTake = takeTraversals(watch.takes, watch.take);
    return () => { letKeep(); letTake(); watch.stop(); leaving.current = null; };
  }, [guard]);

  useEffect(() => {
    let cancelled = false;
    accountRequest<{ account: Account }>("/api/account").then(identity => {
      if (!cancelled) { setLoaded({ account: identity.account }); setError(null); }
    }).catch(failure => { if (!cancelled) setError(failureMessage(failure)); });
    return () => { cancelled = true; };
  }, [attempt]);

  // The account card saved on its tab is shown as saved when the tab opens
  // again: the frame keeps the account it starts from. The instance's
  // settings are read afresh each time General opens.
  useEffect(() => {
    let cancelled = false;
    const account = () => {
      void accountRequest<{ account: Account }>("/api/account").then(body => {
        if (!cancelled) setLoaded(current => current && { ...current, account: body.account });
      }).catch(() => { /* the card that saved already shows what it kept */ });
    };
    window.addEventListener(DISPLAY_NAME_EVENT, account);
    return () => {
      cancelled = true;
      window.removeEventListener(DISPLAY_NAME_EVENT, account);
    };
  }, []);

  const admin = loaded ? loaded.account.isAdmin : null;
  const follow = useEffectEvent(() => {
    if (admin === null) return;
    const hash = window.location.hash;
    // Only the next observation can be the router's answer: a replace that
    // changes the fragment alone moves no path, so it never comes back.
    const expected = echo.current;
    echo.current = null;
    if (expected === pathname + hash) return;
    const place = resolveSettingsAddress({ pathname, hash, admin, lastTab: readLastTab() });
    if (place.replace) {
      echo.current = place.address;
      router.replace(place.address, { scroll: false });
    }
    writeLastTab(place.tab);
    here.current = { tab: place.tab, admin };
    setPane(toward(pane, place.tab, events, guard.holding()));
    setShown(previous => ({ tab: place.tab, anchor: place.anchor, visit: (previous?.visit ?? 0) + 1 }));
  });
  useEffect(() => { follow(); }, [admin, pathname]);
  useEffect(() => {
    // A fragment-only change (an in-page link, back or forward between
    // rows) moves no path, so the router does not report it.
    const onHash = () => follow();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (!shown) return;
    const tabChanged = lastTab.current !== null && lastTab.current !== shown.tab;
    lastTab.current = shown.tab;
    pending.current = shown.anchor;
    if (tabChanged) toTop.current = !shown.anchor;
    arrive();
  }, [shown]);

  useEffect(() => {
    if (!landing) return;
    if (landing.pointer) {
      const target = landing.pointer === "users" ? document.getElementById("settings-users")
        : document.querySelector<HTMLElement>('[aria-label="Switch between dark and light theme"]');
      if (target) markOutside(target);
    } else if (landing.anchor) {
      pending.current = landing.anchor;
      arrive();
    }
  }, [landing]);

  // A tab taken on screen, or rows drawn there: land where the address or a hit said.
  useEffect(() => { arrive(); }, [pane, drawnRows]);

  // A tab still reading after a moment shows in its own loading state.
  useEffect(() => {
    const incoming = pane.incoming;
    if (!incoming) return;
    const timer = setTimeout(() => events.ready(incoming), PENDING_DELAY_MS);
    return () => clearTimeout(timer);
  }, [pane.incoming, events]);

  /** A search hit: a control outside the page or a row on this tab at
   * once, another tab once the person lets this one go. */
  const choose = (hit: SearchHit) => {
    const next = (target: Omit<Landing, "seq">) => setLanding(previous => ({ ...target, seq: (previous?.seq ?? 0) + 1 }));
    if ("pointer" in hit.target) { search.onQuery(""); next({ anchor: null, pointer: hit.target.pointer }); return; }
    const { tab, anchor } = hit.target;
    if (tab === here.current.tab) { search.onQuery(""); next({ anchor, pointer: null }); return; }
    void leaving.current?.leave(tabAddress(tab, anchor)).then(went => { if (went) search.onQuery(""); });
  };

  return <div className={styles.screen}>
    <div className={styles.heading}><h1>Settings</h1></div>
    {error && <ErrorNote message={error} onRetry={() => { setError(null); setAttempt(value => value + 1); }} />}
    {!loaded && !error && <Pending><p role="status" className={styles.loading}>Loading settings…</p></Pending>}
    {loaded && shown && <GuardContext.Provider value={guard}><LiveContext.Provider value={live}>
      <div className={styles.set}>
        <SettingsColumn admin={loaded.account.isAdmin} current={search.searching ? null : shown.tab}
          search={<SearchField value={search.query} inputRef={search.field} onQuery={search.onQuery} onKeyDown={event => search.fieldKeys(event, choose)} />} />
        <div className={styles.pane}>
          {/* The tab on screen stays, held still, while the tab the address names
              reads out of sight; both are kept while the search answers in their
              place, so nothing typed is lost. */}
          {[pane.visible, pane.incoming].map(slot => slot && <div key={slot.id} ref={slot === pane.visible ? content : undefined}
            className={styles.content} data-tab={slot.tab} hidden={slot !== pane.visible || search.searching}
            inert={slot === pane.visible && pane.incoming !== null}>
            <DrawnContext.Provider value={slot}><Mounted slot={slot}><TabContent tab={slot.tab} loaded={loaded} /></Mounted></DrawnContext.Provider>
          </div>)}
          {search.searching && <SearchResults query={search.query} hits={search.hits} loading={search.loading} listRef={search.list}
            onChoose={choose} onField={search.focusField} />}
        </div>
      </div>
    </LiveContext.Provider></GuardContext.Provider>}
    {asking && <LeaveDialog message={asking.message} onAnswer={discard => { asking.settle(discard); setAsking(null); }} />}
  </div>;
}

/** Tells the slot its tab has mounted: this effect runs after every part
 * of the tab has held what it reads. */
function Mounted({ slot, children }: { slot: TabSlot; children: ReactNode }) {
  useEffect(() => {
    slot.mount();
    return () => slot.unmount();
  }, [slot]);
  return children;
}

/** What it holds, once a moment has passed without anything to show. */
function Pending({ children }: { children: ReactNode }) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLate(true), PENDING_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  return late ? children : null;
}

/** What each tab draws. Account, Tokens and Appearance hold the person's
 * own cards; General, Maps, Workflows & SQL, Publishing, Limits and
 * System draw from the configuration read. */
function TabContent({ tab, loaded }: { tab: SettingsTabId; loaded: Loaded }) {
  switch (tab) {
    case "account": return <AccountCard account={loaded.account} />;
    case "tokens": return <TokensCard admin={loaded.account.isAdmin} />;
    case "appearance": return <AppearanceTab />;
    case "general": return <GeneralTab admin={loaded.account.isAdmin} />;
    case "maps": return <MapsTab />;
    case "workflows": return <WorkflowsTab />;
    case "publishing": return <PublishingTab />;
    case "limits": return <LimitsTab />;
    case "security": return <SecurityTab />;
    case "system": return <SystemTab />;
  }
}
