import { describe, expect, it, vi } from "vitest";
import { watchLeaving } from "./leave-watch";

/**
 * Leaving the Settings tab on screen while it holds unsaved text: a link,
 * a search hit, back, forward, reload or closing. The browser here is a
 * fake session history: entries with their state, a push that drops what
 * lay ahead, and back and forward that move only when the test lets them,
 * telling every listener as a browser does. The router's own listener is
 * not here: nothing in this watch stops it, so it always follows.
 */

type Listener = (event: never) => void;
const ORIGIN = "https://dezfil.example";
interface Entry { address: string; state: unknown }

function fakeBrowser(addresses: string[], at = addresses.length - 1) {
  const listeners = new Map<string, Listener[]>();
  const docListeners = new Map<string, Listener[]>();
  const queued: number[] = [];
  let list: Entry[] = addresses.map(address => ({ address, state: { router: address } })), index = at;
  const fire = (map: Map<string, Listener[]>, type: string, event: object) => { for (const fn of [...(map.get(type) ?? [])]) (fn as (e: object) => void)(event); };
  const add = (map: Map<string, Listener[]>) => (type: string, fn: Listener) => { map.set(type, [...(map.get(type) ?? []), fn]); };
  const remove = (map: Map<string, Listener[]>) => (type: string, fn: Listener) => { map.set(type, (map.get(type) ?? []).filter(l => l !== fn)); };
  const win = {
    location: { get href() { return ORIGIN + list[index].address; }, get origin() { return ORIGIN; } },
    history: {
      get state() { return list[index].state; },
      pushState: vi.fn((state: unknown, _unused: string, url?: string) => {
        list = [...list.slice(0, index + 1), { address: url ?? list[index].address, state }];
        index += 1;
      }),
      back: vi.fn(() => { queued.push(-1); }),
      go: vi.fn((delta: number) => { queued.push(delta); }),
    },
    addEventListener: add(listeners), removeEventListener: remove(listeners),
  };
  const doc = { addEventListener: add(docListeners), removeEventListener: remove(docListeners) };
  /** A traversal: the entry moves, then the browser says so. Nothing happens at either end. */
  function traverse(delta: number) {
    const target = index + delta;
    if (target < 0 || target >= list.length) return null;
    index = target;
    const event = { type: "popstate", state: list[index].state };
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
    push(address: string) { list = [...list.slice(0, index + 1), { address, state: { router: address } }]; index += 1; },
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
 * Watch the tab on screen. The private workspace's own listener (does
 * this page keep the traversal?) is heard both before and after the
 * watch's, since browsers differ in which runs first.
 */
function watch(browser: ReturnType<typeof fakeBrowser>, { holding = true } = {}) {
  const guard = fakeGuard();
  const { ask, answer } = deferred();
  const open = vi.fn();
  const shown = browser.address;
  const kept: [boolean, boolean][] = [];
  let first = false;
  browser.win.addEventListener("popstate", (() => { first = page.keeps(); }) as Listener);
  const page = watchLeaving(browser.win as unknown as Window, browser.doc as unknown as Document, {
    guard,
    staysOnTab: url => tabOf(url) === tabOf(new URL(ORIGIN + shown)),
    ask, open,
  });
  browser.win.addEventListener("popstate", (() => { kept.push([first, page.keeps()]); }) as Listener);
  if (holding) guard.hold(true);
  return { guard, ask, answer, open, page, kept };
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

  it("does not hold a jump off the tab: the document is not kept and reload asks the browser's question", () => {
    const browser = fakeBrowser(["/maps", "/settings/account"]);
    const tab = watch(browser);
    browser.traverse(-2);
    expect(browser.address).toBe("/maps");
    expect(tab.ask).not.toHaveBeenCalled();
    expect(tab.kept).toEqual([[false, false]]);
    expect(browser.unload().defaultPrevented).toBe(true);
  });

  it("asks once however often Back is pressed while it asks, and an answer after the page went does nothing", async () => {
    const browser = fakeBrowser(["/maps", "/settings/account"]);
    const tab = watch(browser);
    browser.back();
    browser.back();
    expect(browser.address).toBe("/maps");
    expect(tab.ask).toHaveBeenCalledTimes(1);
    const pushes = browser.win.history.pushState.mock.calls.length;
    await tab.answer(false);
    expect(browser.win.history.pushState).toHaveBeenCalledTimes(pushes);
    expect(browser.queued).toEqual([]);
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
