import { afterEach, describe, expect, it, vi } from "vitest";
import { watchLeaving } from "./leave-watch";
import { watchPrivateWorkspace } from "../auth/private-workspace";
import { keepTraversals, letTraversalGo, takeTraversals } from "../auth/kept-traversals";
import { openPrivateState } from "../auth/private-state";

/**
 * Leaving the Settings tab on screen while it holds unsaved text: a link,
 * a search hit, back, forward, reload or closing. The browser here is a
 * fake session history: entries with their state, a push that drops what
 * lay ahead, and back and forward that move only when the test lets them,
 * telling every listener in turn as a browser does, until one stops the
 * step. The private workspace is heard before the watch, as its capture
 * listener is, and asks whether the page keeps or takes the step; the
 * router is heard after it, so it hears only what nobody stopped.
 */

type Listener = (event: never) => void;
const ORIGIN = "https://dezfil.example";
interface Entry { address: string; state: unknown; key: string }
interface Step { type: string; state: unknown; stopped: boolean; stopImmediatePropagation(): void }

function fakeBrowser(addresses: string[], at = addresses.length - 1, { keys = false } = {}) {
  const listeners = new Map<string, Listener[]>();
  const docListeners = new Map<string, Listener[]>();
  const queued: number[] = [];
  let made = 0;
  const entry = (address: string, state: unknown): Entry => ({ address, state, key: `k${made++}` });
  let list: Entry[] = addresses.map(address => entry(address, { router: address })), index = at;
  const fire = (map: Map<string, Listener[]>, type: string, event: object) => {
    for (const fn of [...(map.get(type) ?? [])]) {
      (fn as (e: object) => void)(event);
      if ((event as Partial<Step>).stopped) return;
    }
  };
  const add = (map: Map<string, Listener[]>) => (type: string, fn: Listener) => { map.set(type, [...(map.get(type) ?? []), fn]); };
  const remove = (map: Map<string, Listener[]>) => (type: string, fn: Listener) => { map.set(type, (map.get(type) ?? []).filter(l => l !== fn)); };
  /** An address a page passes to the history, as the entry's path, query and fragment. */
  const addressOf = (url: string | URL | null | undefined) => {
    if (url === undefined || url === null) return list[index].address;
    const parsed = new URL(String(url), ORIGIN + list[index].address);
    return parsed.pathname + parsed.search + parsed.hash;
  };
  const win = {
    location: { get href() { return ORIGIN + list[index].address; }, get origin() { return ORIGIN; }, replace: vi.fn() },
    history: {
      get state() { return list[index].state; },
      pushState: vi.fn((state: unknown, _unused: string, url?: string | URL | null) => {
        list = [...list.slice(0, index + 1), entry(addressOf(url), state)];
        index += 1;
      }),
      replaceState: vi.fn((state: unknown, _unused: string, url?: string | URL | null) => {
        list[index] = { ...list[index], address: addressOf(url), state };
      }),
      back: vi.fn(() => { queued.push(-1); }),
      go: vi.fn((delta: number) => { queued.push(delta); }),
    },
    fetch: vi.fn(async () => Response.json({ account: { id: "alice" } })),
    addEventListener: add(listeners), removeEventListener: remove(listeners),
    // The Navigation API, where a browser reports its entries: a key per entry that a replace keeps, and where it sits.
    ...(keys ? { navigation: {
      get currentEntry() { return { key: list[index].key, index }; },
      entries: () => list.map((item, position) => ({ key: item.key, index: position })),
    } } : {}),
  };
  const doc = {
    addEventListener: add(docListeners), removeEventListener: remove(docListeners),
    documentElement: { hidden: false }, visibilityState: "visible", title: "Settings",
  };
  /** A traversal: the entry moves, then the browser says so. Nothing happens at either end. */
  function traverse(delta: number) {
    const target = index + delta;
    if (target < 0 || target >= list.length) return null;
    index = target;
    const event: Step = { type: "popstate", state: list[index].state, stopped: false, stopImmediatePropagation() { this.stopped = true; } };
    fire(listeners, "popstate", event);
    return event;
  }
  return {
    win, doc,
    get address() { return list[index].address; },
    get entries() { return list.map(entry => entry.address); },
    get index() { return index; },
    get queued() { return [...queued]; },
    traverse,
    back: () => traverse(-1),
    forward: () => traverse(1),
    /** The router pushes an entry of its own. */
    push(address: string) { list = [...list.slice(0, index + 1), entry(address, { router: address })]; index += 1; },
    /** The router replaces the entry on screen at the same address, writing
     * its own state through whatever replace the window has at the time. */
    rewrite() { win.history.replaceState({ router: list[index].address }, ""); },
    /** Runs the traversals the page asked for. */
    settle() { while (queued.length) traverse(queued.shift()!); },
    click(href: string, extra: Record<string, unknown> = {}, attributes: Record<string, string> = {}) {
      const anchor = { getAttribute: (name: string) => name === "href" ? href : attributes[name] ?? null, hasAttribute: (name: string) => name in attributes };
      const event = { type: "click", button: 0, defaultPrevented: false, target: { closest: () => anchor }, preventDefault() { this.defaultPrevented = true; }, ...extra };
      fire(docListeners, "click", event);
      return event;
    },
    key() { fire(docListeners, "keydown", { type: "keydown" }); },
    unload() {
      const event = { type: "beforeunload", defaultPrevented: false, returnValue: undefined as unknown, preventDefault() { this.defaultPrevented = true; } };
      fire(listeners, "beforeunload", event);
      return event;
    },
    count: () => [...listeners.values(), ...docListeners.values()].reduce((sum, list) => sum + list.length, 0),
  };
}

function fakeGuard() {
  const listeners = new Set<() => void>();
  let holding = false;
  return {
    holding: () => holding,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    hold(value: boolean) { holding = value; for (const listener of [...listeners]) listener(); },
    get listening() { return listeners.size; },
  };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function deferred() {
  const answers: ((discard: boolean) => void)[] = [];
  const ask = vi.fn(() => new Promise<boolean>(resolve => { answers.push(resolve); }));
  return { ask, answer: async (discard: boolean) => { answers.shift()!(discard); for (let i = 0; i < 4; i += 1) await Promise.resolve(); } };
}

/** Settings' tabs: a tab is the first path segment under /settings. */
const tabOf = (url: URL) => url.pathname.startsWith("/settings/") ? url.pathname.split("/")[2] : url.pathname;

/**
 * Watch the tab on screen. The private workspace asks first whether the
 * page keeps or takes the traversal; whether it still keeps it is asked
 * again after the watch has heard the step, where the router hears it,
 * since the page's own bookkeeping must not change that answer.
 */
function watch(browser: ReturnType<typeof fakeBrowser>, { holding = true } = {}) {
  const guard = fakeGuard();
  const { ask, answer } = deferred();
  const open = vi.fn(), end = vi.fn();
  const shown = browser.address;
  const kept: [boolean, boolean][] = [];
  /** Whether the page took each step, as the workspace heard it. */
  const taken: boolean[] = [];
  /** The addresses the router heard a step arrive at. */
  const router = vi.fn<(address: string) => void>();
  let first = false;
  browser.win.addEventListener("popstate", (() => { first = page.keeps(); taken.push(page.takes()); }) as Listener);
  const page = watchLeaving(browser.win as unknown as Window, browser.doc as unknown as Document, {
    guard,
    staysOnTab: url => tabOf(url) === tabOf(new URL(ORIGIN + shown)),
    ask, open, end,
  });
  browser.win.addEventListener("popstate", (() => { kept.push([first, page.keeps()]); router(browser.address); }) as Listener);
  if (holding) guard.hold(true);
  return { guard, ask, answer, open, end, page, kept, taken, router };
}

describe("the extra entry while the tab holds", () => {
  it("adds one entry at the same address when text first differs, and takes it away unseen once it is saved", async () => {
    const browser = fakeBrowser(["/maps", "/settings/account"]);
    const tab = watch(browser, { holding: false });
    expect(browser.win.history.pushState).not.toHaveBeenCalled();
    tab.guard.hold(true);
    expect(browser.entries).toEqual(["/maps", "/settings/account", "/settings/account"]);
    expect(browser.index).toBe(2);
    expect(browser.win.history.pushState).toHaveBeenCalledWith(expect.any(Object), "");
    // Another card holding too adds nothing.
    tab.guard.hold(true);
    expect(browser.win.history.pushState).toHaveBeenCalledTimes(1);
    tab.guard.hold(false);
    expect(browser.queued).toEqual([-1]);
    browser.settle();
    await tick();
    expect(browser.index).toBe(1);
    // The workspace kept that step in the document, whichever heard it first.
    expect(tab.kept).toEqual([[true, true]]);
    expect(tab.ask).not.toHaveBeenCalled();
    expect(tab.open).not.toHaveBeenCalled();
  });

  it("knows its extra entry by the entry's key after the router rewrites that entry's state", async () => {
    const browser = fakeBrowser(["/maps", "/settings/account"], 1, { keys: true });
    const tab = watch(browser);
    // Clicking the tab already open replaces the entry on screen.
    browser.rewrite();
    tab.guard.hold(false);
    expect(browser.queued).toEqual([-1]);
    browser.settle();
    await tick();
    expect(browser.index).toBe(1);
    expect(tab.kept).toEqual([[true, true]]);
  });

  it("keeps its mark on the extra entry when the router rewrites that entry's state, where the browser reports no entry keys", async () => {
    const browser = fakeBrowser(["/maps", "/settings/account"]);
    const tab = watch(browser);
    // Clicking the tab already open replaces the entry on screen.
    browser.rewrite();
    expect(browser.win.history.state).toEqual(expect.objectContaining({ router: "/settings/account" }));
    tab.guard.hold(false);
    expect(browser.queued).toEqual([-1]);
    browser.settle();
    await tick();
    expect(browser.index).toBe(1);
    expect(browser.entries).toEqual(["/maps", "/settings/account", "/settings/account"]);
    expect(tab.kept).toEqual([[true, true]]);
    // Nothing held now: Back leaves for the page before, not the same tab again.
    browser.back();
    expect(browser.address).toBe("/maps");
  });

  it("marks no other entry when the router rewrites it, and stops marking once stopped", async () => {
    const browser = fakeBrowser(["/maps", "/settings/account"]);
    const original = browser.win.history.replaceState;
    const tab = watch(browser);
    browser.back();
    // On the tab's own entry while it asks: the router's state alone.
    browser.rewrite();
    expect(browser.win.history.state).toEqual({ router: "/settings/account" });
    await tab.answer(false);
    tab.page.stop();
    expect(browser.win.history.replaceState).toBe(original);
    browser.rewrite();
    expect(browser.win.history.state).toEqual({ router: "/settings/account" });
  });

  it("puts the entry back when the text differs again before the last one is gone", async () => {
    const browser = fakeBrowser(["/maps", "/settings/account"]);
    const tab = watch(browser);
    tab.guard.hold(false);
    tab.guard.hold(true);
    browser.settle();
    await tick();
    expect(browser.address).toBe("/settings/account");
    expect(browser.index).toBe(2);
    expect(browser.win.history.pushState).toHaveBeenCalledTimes(2);
  });
});

describe("leaving through back and forward", () => {
  it("lands Back on the same page, keeps it in the document and asks; Keep editing puts the entry back, so Forward has nowhere to go", async () => {
    const browser = fakeBrowser(["/maps", "/settings/account"]);
    const tab = watch(browser);
    browser.back();
    expect(browser.address).toBe("/settings/account");
    expect(tab.kept).toEqual([[true, true]]);
    expect(tab.ask).toHaveBeenCalledTimes(1);
    await tab.answer(false);
    expect(browser.entries).toEqual(["/maps", "/settings/account", "/settings/account"]);
    expect(browser.index).toBe(2);
    expect(browser.forward()).toBeNull();
    expect(browser.address).toBe("/settings/account");
    expect(tab.open).not.toHaveBeenCalled();
    // The next Back is a new leaving, asked again.
    browser.back();
    expect(tab.ask).toHaveBeenCalledTimes(2);
  });

  it("goes back once more when the tab is let go, out of the document's keeping, and the browser's question stays quiet for it", async () => {
    const browser = fakeBrowser(["/maps", "/settings/general"]);
    const tab = watch(browser);
    browser.back();
    await tab.answer(true);
    expect(browser.queued).toEqual([-1]);
    browser.settle();
    expect(browser.address).toBe("/maps");
    expect(tab.kept).toEqual([[true, true], [false, false]]);
    // The workspace reloads at the arrival; this page asked already.
    expect(browser.unload().defaultPrevented).toBe(false);
    expect(tab.ask).toHaveBeenCalledTimes(1);
    expect(tab.open).not.toHaveBeenCalled();
  });

  it("leaves from the page's own entry when Forward went back onto the extra one while it asked", async () => {
    const browser = fakeBrowser(["/maps", "/settings/general"]);
    const tab = watch(browser);
    browser.back();
    browser.forward();
    expect(tab.ask).toHaveBeenCalledTimes(1);
    await tab.answer(true);
    expect(browser.queued).toEqual([-2]);
    browser.settle();
    expect(browser.address).toBe("/maps");
  });

  it("moves within the tab without asking and keeps those moves in the document", async () => {
    const browser = fakeBrowser(["/settings/general#set-landing-page", "/settings/general"]);
    const tab = watch(browser);
    // A row's link pushes above the extra entry; back lands on it.
    browser.push("/settings/general#set-message");
    browser.back();
    expect(browser.address).toBe("/settings/general");
    expect(tab.ask).not.toHaveBeenCalled();
    // A jump of two from the history list to another row of the tab.
    browser.traverse(-2);
    expect(browser.address).toBe("/settings/general#set-landing-page");
    expect(tab.ask).not.toHaveBeenCalled();
    expect(tab.kept).toEqual([[true, true], [true, true]]);
    // The entry is put back over the row landed on, so Back still asks.
    expect(browser.entries).toEqual(["/settings/general#set-landing-page", "/settings/general#set-landing-page"]);
    browser.back();
    expect(tab.ask).toHaveBeenCalledTimes(1);
  });

  it("takes a jump past the tab from the history list: neither the workspace nor the router hears it, and it asks", () => {
    const browser = fakeBrowser(["/maps", "/data", "/settings/account"]);
    const tab = watch(browser);
    browser.traverse(-3);
    expect(browser.address).toBe("/maps");
    expect(tab.taken).toEqual([true]);
    expect(tab.router).not.toHaveBeenCalled();
    expect(tab.ask).toHaveBeenCalledTimes(1);
    expect(tab.end).not.toHaveBeenCalled();
  });

  it("puts the tab's address back on Keep editing by the entry's distance, where the browser reports its entries", async () => {
    const browser = fakeBrowser(["/maps", "/data", "/settings/account"], 2, { keys: true });
    const tab = watch(browser);
    browser.traverse(-3);
    await tab.answer(false);
    expect(browser.queued).toEqual([3]);
    browser.settle();
    expect(browser.address).toBe("/settings/account");
    expect(browser.index).toBe(3);
    expect(browser.entries).toEqual(["/maps", "/data", "/settings/account", "/settings/account"]);
    // The step back is the page's own: taken too, so the router hears neither.
    expect(tab.taken).toEqual([true, true]);
    expect(tab.router).not.toHaveBeenCalled();
    expect(tab.ask).toHaveBeenCalledTimes(1);
    // Held as before: Back asks, and saving takes the extra entry away.
    browser.back();
    expect(tab.ask).toHaveBeenCalledTimes(2);
    await tab.answer(false);
    tab.guard.hold(false);
    expect(browser.queued).toEqual([-1]);
  });

  it("puts the tab's address back on Keep editing as new entries, its own and the extra one, where the browser reports none", async () => {
    const browser = fakeBrowser(["/maps", "/data", "/settings/account"]);
    // The router's state on the tab's own entry, under the extra one.
    const state = browser.win.history.state;
    const tab = watch(browser);
    browser.traverse(-3);
    await tab.answer(false);
    expect(browser.queued).toEqual([]);
    expect(browser.entries).toEqual(["/maps", "/settings/account", "/settings/account"]);
    expect(browser.index).toBe(2);
    expect(tab.router).not.toHaveBeenCalled();
    // The tab's own entry comes back with the state the router left on it, so the router has nothing to restore.
    browser.back();
    expect(browser.win.history.state).toBe(state);
    expect(tab.ask).toHaveBeenCalledTimes(2);
    await tab.answer(false);
    // Saving takes the extra entry away and stays on the tab.
    tab.guard.hold(false);
    browser.settle();
    await tick();
    expect(browser.address).toBe("/settings/account");
    expect(browser.index).toBe(1);
  });

  it("hands a step past the tab to the workspace on Discard, and the browser's question stays quiet for it", async () => {
    const browser = fakeBrowser(["/maps", "/data", "/settings/account"], 2, { keys: true });
    const tab = watch(browser);
    browser.traverse(-3);
    await tab.answer(true);
    expect(tab.end).toHaveBeenCalledOnce();
    expect(browser.queued).toEqual([]);
    expect(browser.address).toBe("/maps");
    expect(browser.unload().defaultPrevented).toBe(false);
    expect(tab.router).not.toHaveBeenCalled();
  });

  it("asks once however often Back is pressed while it asks; a Back past the tab is taken, and the one answer settles where the browser is", async () => {
    const browser = fakeBrowser(["/maps", "/settings/account"]);
    const tab = watch(browser);
    browser.back();
    browser.back();
    expect(browser.address).toBe("/maps");
    expect(tab.ask).toHaveBeenCalledTimes(1);
    expect(tab.taken).toEqual([false, true]);
    // Only the Back that stayed on the tab reached the router.
    expect(tab.router.mock.calls).toEqual([["/settings/account"]]);
    await tab.answer(false);
    expect(browser.address).toBe("/settings/account");
    expect(browser.entries).toEqual(["/maps", "/settings/account", "/settings/account"]);
    expect(tab.end).not.toHaveBeenCalled();
    browser.back();
    browser.back();
    await tab.answer(true);
    expect(tab.end).toHaveBeenCalledOnce();
  });

  it("with nowhere to go back to, lets the next key press take the tab up again", async () => {
    const browser = fakeBrowser(["/settings/account"]);
    const tab = watch(browser);
    browser.back();
    await tab.answer(true);
    browser.settle();
    expect(browser.address).toBe("/settings/account");
    expect(browser.unload().defaultPrevented).toBe(false);
    browser.key();
    expect(browser.entries).toEqual(["/settings/account", "/settings/account"]);
    expect(browser.unload().defaultPrevented).toBe(true);
    browser.back();
    expect(tab.ask).toHaveBeenCalledTimes(2);
  });

  it("asks nothing and adds nothing while nothing is unsaved", () => {
    const browser = fakeBrowser(["/maps", "/settings/account"]);
    const tab = watch(browser, { holding: false });
    browser.back();
    expect(browser.address).toBe("/maps");
    expect(tab.ask).not.toHaveBeenCalled();
    expect(tab.kept).toEqual([[false, false]]);
    expect(browser.win.history.pushState).not.toHaveBeenCalled();
  });
});

describe("leaving through a link or a search hit", () => {
  it("asks before a link leaves the tab with unsaved text, and follows it once the extra entry is gone", async () => {
    const browser = fakeBrowser(["/settings/account"]);
    const tab = watch(browser);
    const kept = browser.click("/settings/tokens");
    expect(kept.defaultPrevented).toBe(true);
    expect(tab.ask).toHaveBeenCalledTimes(1);
    await tab.answer(false);
    expect(tab.open).not.toHaveBeenCalled();
    expect(browser.queued).toEqual([]);
    const left = browser.click("/maps?view=list#top");
    expect(left.defaultPrevented).toBe(true);
    await tab.answer(true);
    expect(tab.open).not.toHaveBeenCalled();
    expect(browser.queued).toEqual([-1]);
    browser.settle();
    expect(tab.kept).toEqual([[true, true]]);
    await tick();
    expect(tab.open).toHaveBeenCalledWith("/maps?view=list#top");
    expect(browser.index).toBe(0);
  });

  it("lets a link go by when nothing is unsaved, when it stays on the tab, or when it opens somewhere else", () => {
    const browser = fakeBrowser(["/settings/account"]);
    const tab = watch(browser);
    expect(browser.click("/settings/account#password").defaultPrevented).toBe(false);
    expect(browser.click("/settings/tokens", { metaKey: true }).defaultPrevented).toBe(false);
    expect(browser.click("/settings/tokens", { button: 1 }).defaultPrevented).toBe(false);
    expect(browser.click("/settings/tokens", {}, { target: "_blank" }).defaultPrevented).toBe(false);
    expect(browser.click("/settings/tokens", {}, { download: "" }).defaultPrevented).toBe(false);
    expect(browser.click("https://elsewhere.example/").defaultPrevented).toBe(false);
    expect(browser.click("/settings/tokens", { defaultPrevented: true }).defaultPrevented).toBe(true);
    expect(tab.ask).not.toHaveBeenCalled();
    tab.guard.hold(false);
    browser.settle();
    expect(browser.click("/settings/tokens").defaultPrevented).toBe(false);
    expect(tab.ask).not.toHaveBeenCalled();
  });

  it("holds a link clicked while the extra entry is being taken away until it is gone", async () => {
    const browser = fakeBrowser(["/settings/account"]);
    const tab = watch(browser);
    tab.guard.hold(false);
    const clicked = browser.click("/settings/tokens");
    expect(clicked.defaultPrevented).toBe(true);
    expect(tab.ask).not.toHaveBeenCalled();
    expect(tab.open).not.toHaveBeenCalled();
    browser.settle();
    await tick();
    expect(tab.open).toHaveBeenCalledWith("/settings/tokens");
  });

  it("opens a search hit's address, asking first only when it leaves a tab that holds", async () => {
    const browser = fakeBrowser(["/settings/account"]);
    const tab = watch(browser);
    await expect(tab.page.leave("/settings/account#password")).resolves.toBe(true);
    expect(tab.open).toHaveBeenLastCalledWith("/settings/account#password");
    expect(tab.ask).not.toHaveBeenCalled();
    const kept = tab.page.leave("/settings/limits#set-preview-rows");
    await tab.answer(false);
    await expect(kept).resolves.toBe(false);
    expect(tab.open).toHaveBeenCalledTimes(1);
    const left = tab.page.leave("/settings/limits#set-preview-rows");
    await tab.answer(true);
    await expect(left).resolves.toBe(true);
    browser.settle();
    await tick();
    expect(tab.open).toHaveBeenLastCalledWith("/settings/limits#set-preview-rows");
  });
});

describe("reload and closing", () => {
  it("asks the browser's own question only while something is unsaved", () => {
    const browser = fakeBrowser(["/settings/account"]);
    const tab = watch(browser);
    const holding = browser.unload();
    expect(holding.defaultPrevented).toBe(true);
    expect(holding.returnValue).toBe("");
    tab.guard.hold(false);
    const free = browser.unload();
    expect(free.defaultPrevented).toBe(false);
    expect(free.returnValue).toBeUndefined();
  });

  it("leaves nothing listening once stopped", () => {
    const browser = fakeBrowser(["/settings/account"]);
    const tab = watch(browser);
    const before = browser.count();
    expect(tab.guard.listening).toBe(1);
    tab.page.stop();
    // Only the test's own two popstate listeners remain.
    expect(browser.count()).toBe(2);
    expect(before).toBeGreaterThan(2);
    expect(tab.guard.listening).toBe(0);
  });
});

describe("held by the private workspace", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function memory(): Storage {
    const data = new Map<string, string>();
    return { get length() { return data.size; }, getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: key => { data.delete(key); }, key: index => [...data.keys()][index] ?? null, clear: () => data.clear() };
  }
  const reads = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };

  it("keeps the document through a jump past the tab answered Keep editing, and ends it where the jump went on Discard", async () => {
    const browser = fakeBrowser(["/maps", "/data", "/settings/account"], 2, { keys: true });
    vi.stubGlobal("BroadcastChannel", undefined);
    vi.stubGlobal("localStorage", memory()); vi.stubGlobal("sessionStorage", memory());
    vi.stubGlobal("window", browser.win); vi.stubGlobal("document", browser.doc);
    openPrivateState("alice");
    const ready = vi.fn();
    const stopWorkspace = watchPrivateWorkspace("alice", ready);
    await reads();
    expect(ready).toHaveBeenLastCalledWith(true);
    // The page, wired as the Settings frame wires it, and the router heard after both.
    const guard = fakeGuard();
    const { ask, answer } = deferred();
    const page = watchLeaving(browser.win as unknown as Window, browser.doc as unknown as Document, {
      guard, staysOnTab: url => tabOf(url) === "account", ask, open: vi.fn(), end: () => { letTraversalGo(); },
    });
    const letKeep = keepTraversals(page.keeps), letTake = takeTraversals(page.takes);
    const router = vi.fn();
    browser.win.addEventListener("popstate", router as Listener);
    try {
      guard.hold(true);
      browser.traverse(-3);
      expect(browser.address).toBe("/maps");
      expect(browser.doc.documentElement.hidden).toBe(false);
      expect(browser.win.location.replace).not.toHaveBeenCalled();
      expect(ready).toHaveBeenLastCalledWith(true);
      expect(router).not.toHaveBeenCalled();
      expect(ask).toHaveBeenCalledOnce();
      await answer(false);
      browser.settle();
      await reads();
      expect(browser.address).toBe("/settings/account");
      expect(browser.doc.documentElement.hidden).toBe(false);
      expect(browser.win.location.replace).not.toHaveBeenCalled();
      expect(router).not.toHaveBeenCalled();
      // Again, and this time the tab is let go: the document ends where the jump went.
      browser.traverse(-3);
      await answer(true);
      expect(browser.win.location.replace).toHaveBeenCalledWith(`${ORIGIN}/maps`);
      expect(browser.doc.documentElement.hidden).toBe(true);
      expect(ready).toHaveBeenLastCalledWith(false);
      expect(browser.unload().defaultPrevented).toBe(false);
    } finally { letKeep(); letTake(); page.stop(); stopWorkspace(); }
  });

  it("ends the document on a step past the tab when the session names another account, unsaved text or not", async () => {
    const browser = fakeBrowser(["/maps", "/data", "/settings/account"], 2, { keys: true });
    vi.stubGlobal("BroadcastChannel", undefined);
    vi.stubGlobal("localStorage", memory()); vi.stubGlobal("sessionStorage", memory());
    vi.stubGlobal("window", browser.win); vi.stubGlobal("document", browser.doc);
    openPrivateState("alice");
    // The transport the workspace reads the session with, before it guards the window's fetch.
    const session = browser.win.fetch;
    const ready = vi.fn();
    const stopWorkspace = watchPrivateWorkspace("alice", ready);
    await reads();
    const guard = fakeGuard();
    const page = watchLeaving(browser.win as unknown as Window, browser.doc as unknown as Document, {
      guard, staysOnTab: url => tabOf(url) === "account", ask: deferred().ask, open: vi.fn(), end: () => { letTraversalGo(); },
    });
    const letKeep = keepTraversals(page.keeps), letTake = takeTraversals(page.takes);
    try {
      guard.hold(true);
      // Another account signed in, with no notice reaching this tab.
      session.mockImplementation(async () => Response.json({ account: { id: "bob" } }));
      browser.traverse(-3);
      await reads();
      expect(browser.win.location.replace).toHaveBeenCalledWith(`${ORIGIN}/maps`);
      expect(browser.doc.documentElement.hidden).toBe(true);
      expect(ready).toHaveBeenLastCalledWith(false);
    } finally { letKeep(); letTake(); page.stop(); stopWorkspace(); }
  });
});
