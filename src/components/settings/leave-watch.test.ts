import { describe, expect, it, vi } from "vitest";
import { watchLeaving } from "./leave-watch";

/**
 * Leaving the Settings tab on screen while it holds unsaved text: a link,
 * back, forward, reload or closing. The browser here is a fake whose
 * history moves only when the test lets it, and whose entries know their
 * position the way the Navigation API reports it.
 */

type Listener = (event: never) => void;
const ORIGIN = "https://dezfil.example";

function fakeBrowser(entries: string[], at = entries.length - 1, { positions = true } = {}) {
  const listeners = new Map<string, Listener[]>();
  const docListeners = new Map<string, Listener[]>();
  const queued: number[] = [];
  let list = [...entries], index = at;
  const fire = (map: Map<string, Listener[]>, type: string, event: object) => { for (const fn of [...(map.get(type) ?? [])]) (fn as (e: object) => void)(event); };
  const navigation = {
    get currentEntry() { return { index }; },
    addEventListener: (type: string, fn: Listener) => { listeners.set(`nav:${type}`, [...(listeners.get(`nav:${type}`) ?? []), fn]); },
    removeEventListener: (type: string, fn: Listener) => { listeners.set(`nav:${type}`, (listeners.get(`nav:${type}`) ?? []).filter(l => l !== fn)); },
  };
  const win = {
    location: { get href() { return ORIGIN + list[index]; }, get origin() { return ORIGIN; } },
    history: { go: vi.fn((delta: number) => { queued.push(delta); }) },
    ...(positions ? { navigation } : {}),
    addEventListener: (type: string, fn: Listener) => { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
    removeEventListener: (type: string, fn: Listener) => { listeners.set(type, (listeners.get(type) ?? []).filter(l => l !== fn)); },
  };
  const doc = {
    addEventListener: (type: string, fn: Listener) => { docListeners.set(type, [...(docListeners.get(type) ?? []), fn]); },
    removeEventListener: (type: string, fn: Listener) => { docListeners.set(type, (docListeners.get(type) ?? []).filter(l => l !== fn)); },
  };
  /** A traversal: the entry moves, then the browser says so. */
  function traverse(delta: number) {
    index += delta;
    fire(listeners, "nav:currententrychange", {});
    const event = { type: "popstate", stopped: false, stopImmediatePropagation() { this.stopped = true; } };
    fire(listeners, "popstate", event);
    return event;
  }
  return {
    win, doc,
    get address() { return list[index]; },
    get queued() { return [...queued]; },
    traverse,
    back: () => traverse(-1),
    /** The router pushes an entry. */
    push(address: string) { list = [...list.slice(0, index + 1), address]; index += 1; fire(listeners, "nav:currententrychange", {}); },
    /** Runs the traversals the page asked for, returning what the router would have seen. */
    settle() { const out = []; while (queued.length) out.push(traverse(queued.shift()!)); return out; },
    click(href: string, extra: Record<string, unknown> = {}, attributes: Record<string, string> = {}) {
      const anchor = { getAttribute: (name: string) => name === "href" ? href : attributes[name] ?? null, hasAttribute: (name: string) => name in attributes };
      const event = { type: "click", button: 0, defaultPrevented: false, target: { closest: () => anchor }, preventDefault() { this.defaultPrevented = true; }, ...extra };
      fire(docListeners, "click", event);
      return event;
    },
    unload() {
      const event = { type: "beforeunload", defaultPrevented: false, returnValue: undefined as unknown, preventDefault() { this.defaultPrevented = true; } };
      fire(listeners, "beforeunload", event);
      return event;
    },
    count: () => [...listeners.values(), ...docListeners.values()].reduce((sum, list) => sum + list.length, 0),
  };
}

function deferred() {
  const answers: ((discard: boolean) => void)[] = [];
  const ask = vi.fn(() => new Promise<boolean>(resolve => { answers.push(resolve); }));
  return { ask, answer: async (discard: boolean) => { answers.shift()!(discard); await Promise.resolve(); await Promise.resolve(); } };
}

/** Settings' tabs: a tab is the first path segment under /settings. */
const tabOf = (url: URL) => url.pathname.startsWith("/settings/") ? url.pathname.split("/")[2] : url.pathname;

function watch(browser: ReturnType<typeof fakeBrowser>, holding = true) {
  const state = { holding };
  const { ask, answer } = deferred();
  const open = vi.fn();
  /** The address of the tab on screen, as the page shows it. */
  const shown = browser.address;
  const stop = watchLeaving(browser.win as unknown as Window, browser.doc as unknown as Document, {
    guard: { holding: () => state.holding },
    staysOnTab: url => tabOf(url) === tabOf(new URL(ORIGIN + shown)),
    here: () => shown,
    ask, open,
  });
  return { state, ask, answer, open, stop };
}

describe("leaving through a link", () => {
  it("asks before a link leaves the tab with unsaved text, and follows it only when the tab is let go", async () => {
    const browser = fakeBrowser(["/settings/account"]);
    const page = watch(browser);
    const kept = browser.click("/settings/tokens");
    expect(kept.defaultPrevented).toBe(true);
    expect(page.ask).toHaveBeenCalledTimes(1);
    await page.answer(false);
    expect(page.open).not.toHaveBeenCalled();
    const left = browser.click("/maps?view=list#top");
    expect(left.defaultPrevented).toBe(true);
    await page.answer(true);
    expect(page.open).toHaveBeenCalledWith("/maps?view=list#top");
  });

  it("lets a link go by when nothing is unsaved, when it stays on the tab, or when it opens somewhere else", () => {
    const browser = fakeBrowser(["/settings/account"]);
    const page = watch(browser);
    expect(browser.click("/settings/account#password").defaultPrevented).toBe(false);
    expect(browser.click("/settings/tokens", { metaKey: true }).defaultPrevented).toBe(false);
    expect(browser.click("/settings/tokens", { button: 1 }).defaultPrevented).toBe(false);
    expect(browser.click("/settings/tokens", {}, { target: "_blank" }).defaultPrevented).toBe(false);
    expect(browser.click("/settings/tokens", {}, { download: "" }).defaultPrevented).toBe(false);
    expect(browser.click("https://elsewhere.example/").defaultPrevented).toBe(false);
    expect(browser.click("/settings/tokens", { defaultPrevented: true }).defaultPrevented).toBe(true);
    expect(page.ask).not.toHaveBeenCalled();
    page.state.holding = false;
    expect(browser.click("/settings/tokens").defaultPrevented).toBe(false);
    expect(page.ask).not.toHaveBeenCalled();
  });
});

describe("leaving through back and forward", () => {
  it("puts the address back before the router sees it, asks, and goes back again when the tab is let go", async () => {
    const browser = fakeBrowser(["/maps", "/settings/account", "/settings/general"]);
    const page = watch(browser);
    const back = browser.back();
    expect(back.stopped).toBe(true);
    expect(browser.queued).toEqual([1]);
    expect(page.ask).toHaveBeenCalledTimes(1);
    const [restore] = browser.settle();
    expect(restore.stopped).toBe(true);
    expect(browser.address).toBe("/settings/general");
    await page.answer(true);
    expect(browser.queued).toEqual([-1]);
    const [arrival] = browser.settle();
    expect(arrival.stopped).toBe(false);
    expect(browser.address).toBe("/settings/account");
    expect(page.ask).toHaveBeenCalledTimes(1);
  });

  it("does the same for forward, across more than one entry", async () => {
    const browser = fakeBrowser(["/settings/general", "/settings/account", "/maps"], 0);
    const page = watch(browser);
    // Forward's list, two entries ahead.
    const jump = browser.traverse(2);
    expect(jump.stopped).toBe(true);
    expect(browser.queued).toEqual([-2]);
    expect(page.ask).toHaveBeenCalledTimes(1);
    browser.settle();
    expect(browser.address).toBe("/settings/general");
    await page.answer(true);
    expect(browser.queued).toEqual([2]);
    const [arrival] = browser.settle();
    expect(arrival.stopped).toBe(false);
    expect(browser.address).toBe("/maps");
    expect(page.open).not.toHaveBeenCalled();
  });

  it("keeps the tab and its address when the person keeps editing", async () => {
    const browser = fakeBrowser(["/settings/account", "/settings/general"]);
    const page = watch(browser);
    browser.back();
    browser.settle();
    await page.answer(false);
    expect(browser.queued).toEqual([]);
    expect(browser.address).toBe("/settings/general");
    // The next back is a new leaving, asked again.
    expect(browser.back().stopped).toBe(true);
    expect(page.ask).toHaveBeenCalledTimes(2);
  });

  it("asks once however often back is pressed while it asks", async () => {
    const browser = fakeBrowser(["/maps", "/settings/account", "/settings/general"]);
    const page = watch(browser);
    browser.back();
    browser.settle();
    expect(browser.back().stopped).toBe(true);
    browser.settle();
    expect(page.ask).toHaveBeenCalledTimes(1);
    await page.answer(false);
    expect(browser.address).toBe("/settings/general");
  });

  it("follows back and forward within the tab, and every move while nothing is unsaved, without asking", () => {
    const browser = fakeBrowser(["/settings/general", "/settings/general#set-landing-page"]);
    const page = watch(browser);
    expect(browser.back().stopped).toBe(false);
    page.state.holding = false;
    browser.push("/settings/tokens");
    expect(browser.back().stopped).toBe(false);
    expect(page.ask).not.toHaveBeenCalled();
    expect(browser.queued).toEqual([]);
  });

  it("without entry positions, puts the address back as a new entry and opens the arrival when the tab is let go", async () => {
    const browser = fakeBrowser(["/settings/account", "/settings/general"], 1, { positions: false });
    const page = watch(browser);
    expect(browser.back().stopped).toBe(true);
    expect(browser.queued).toEqual([]);
    expect(page.open).toHaveBeenCalledWith("/settings/general");
    await page.answer(true);
    expect(page.open).toHaveBeenLastCalledWith("/settings/account");
  });
});

describe("reload and closing", () => {
  it("asks the browser's own question only while something is unsaved", () => {
    const browser = fakeBrowser(["/settings/account"]);
    const page = watch(browser);
    const holding = browser.unload();
    expect(holding.defaultPrevented).toBe(true);
    expect(holding.returnValue).toBe("");
    page.state.holding = false;
    const free = browser.unload();
    expect(free.defaultPrevented).toBe(false);
    expect(free.returnValue).toBeUndefined();
  });

  it("leaves nothing listening once stopped", () => {
    const browser = fakeBrowser(["/settings/account"]);
    const page = watch(browser);
    expect(browser.count()).toBeGreaterThan(0);
    page.stop();
    expect(browser.count()).toBe(0);
  });
});
