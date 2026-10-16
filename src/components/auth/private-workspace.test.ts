import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TRAVERSAL_GRACE_MS, watchPrivateWorkspace } from "./private-workspace";
import { keepTraversals, letTraversalGo, takeTraversals } from "./kept-traversals";
import { ACCOUNT_STORAGE_KEY, accountChanged, openPrivateState, privateStateOpen } from "./private-state";
import { readStored, SQL_KEYS, writeStored } from "../sql/sql-storage";
import { conversation, LOCATOR_KEY } from "../builder/assistant/conversation-store";
import { contributePath, pathObjectFor } from "../shell/path-model";
import { createStringStore } from "../builder/preference-store";

function memory(): Storage {
  const data = new Map<string, string>();
  return { get length() { return data.size; }, getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: key => { data.delete(key); }, key: index => [...data.keys()][index] ?? null, clear: () => data.clear() };
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
let win: EventTarget & { location: { origin: string; href: string; replace: ReturnType<typeof vi.fn> }; fetch: typeof fetch };
let doc: EventTarget & { documentElement: { hidden: boolean }; visibilityState: string; title: string };
let dispose: (() => void) | undefined;
beforeEach(() => {
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("localStorage", memory()); vi.stubGlobal("sessionStorage", memory());
  win = Object.assign(new EventTarget(), { location: { origin: "http://instance.test", href: "http://instance.test/maps/copied-id", replace: vi.fn() }, fetch: vi.fn<typeof fetch>(async () => Response.json({ account: { id: "alice" } })) });
  doc = Object.assign(new EventTarget(), { documentElement: { hidden: false }, visibilityState: "visible", title: "Alice's map" });
  vi.stubGlobal("window", win); vi.stubGlobal("document", doc);
  openPrivateState("alice");
});
afterEach(() => { dispose?.(); dispose = undefined; vi.unstubAllGlobals(); });

it("mounts only after a fresh identity read, preserves same-account reload drafts and retires on a changed identity", async () => {
  writeStored(SQL_KEYS.draft, { text: "Alice's SQL" });
  conversation.active = { id: "alice-receipt", message: "Alice's message" };
  const ready = vi.fn(); dispose = watchPrivateWorkspace("alice", ready);
  expect(ready).not.toHaveBeenCalled(); expect(doc.documentElement.hidden).toBe(true);
  await flush(); expect(ready).toHaveBeenLastCalledWith(true); expect(doc.documentElement.hidden).toBe(false);
  expect(readStored(SQL_KEYS.draft, null)).toEqual({ text: "Alice's SQL" });
  expect(conversation.active?.id).toBe("alice-receipt");
  contributePath("/maps/copied-id", { name: "Alice's map", projectId: "alice-project" });
  const remembered = createStringStore("dezfil:private-style"); remembered.write("Alice's private fingerprint");
  accountChanged();
  expect(doc.documentElement.hidden).toBe(true); expect(ready).toHaveBeenLastCalledWith(false);
  expect(pathObjectFor("/maps/copied-id")).toBeNull(); expect(conversation.active).toBeNull();
  expect(sessionStorage.getItem(LOCATOR_KEY)).toBeNull();
  expect(doc.title).toBe("Dezfil");
  remembered.write("late private fingerprint");
  expect(localStorage.getItem("dezfil:private-style")).toBeNull();
  expect(win.location.replace).toHaveBeenCalledWith(win.location.href);
});
it.each(["storage", "pageshow"])("conceals and reloads a %s restore instead of reusing private state", async kind => {
  const ready = vi.fn(); dispose = watchPrivateWorkspace("alice", ready); await flush();
  const event = new Event(kind);
  if (kind === "storage") Object.defineProperty(event, "key", { value: ACCOUNT_STORAGE_KEY });
  if (kind === "pageshow") { win.dispatchEvent(new Event("pagehide")); expect(doc.documentElement.hidden).toBe(true); Object.defineProperty(event, "persisted", { value: true }); }
  win.dispatchEvent(event);
  expect(doc.documentElement.hidden).toBe(true); expect(ready).toHaveBeenLastCalledWith(false);
  expect(win.location.replace).toHaveBeenCalledWith("http://instance.test/maps/copied-id");
  await expect(win.fetch("/api/maps")).rejects.toMatchObject({ name: "AbortError" });
});
it("leaves the page shown and working when the reload a Back or Forward starts is cancelled at the leave prompt, and hides it only as the document goes", async () => {
  const ready = vi.fn(); dispose = watchPrivateWorkspace("alice", ready); await flush();
  // The browser asks before leaving a page holding unsaved work; Stay
  // cancels the reload, which the stub's replace stands for by doing nothing.
  win.dispatchEvent(new Event("popstate"));
  expect(win.location.replace).toHaveBeenCalledWith("http://instance.test/maps/copied-id");
  expect(doc.documentElement.hidden).toBe(false);
  expect(ready).toHaveBeenLastCalledWith(true); expect(ready).not.toHaveBeenCalledWith(false);
  expect(doc.title).toBe("Alice's map");
  expect(privateStateOpen()).toBe(true);
  await expect(win.fetch("/api/maps")).resolves.toBeInstanceOf(Response);
  // The page still answers the next Back or Forward, and a step a page lets go.
  win.dispatchEvent(new Event("popstate"));
  expect(letTraversalGo()).toBe(true);
  expect(win.location.replace).toHaveBeenCalledTimes(3);
  expect(doc.documentElement.hidden).toBe(false);
  // The reload goes ahead: the page hides as the document goes.
  win.dispatchEvent(new Event("pagehide"));
  expect(doc.documentElement.hidden).toBe(true);
});
it("keeps a Back or Forward the page on screen claims, and reloads every other one", async () => {
  const ready = vi.fn(); dispose = watchPrivateWorkspace("alice", ready); await flush();
  let keeping = true;
  const letGo = keepTraversals(() => keeping);
  try {
    win.dispatchEvent(new Event("popstate"));
    expect(win.location.replace).not.toHaveBeenCalled();
    expect(doc.documentElement.hidden).toBe(false); expect(ready).toHaveBeenLastCalledWith(true);
    keeping = false;
    win.dispatchEvent(new Event("popstate"));
    expect(win.location.replace).toHaveBeenCalledWith("http://instance.test/maps/copied-id");
    win.dispatchEvent(new Event("pagehide"));
    expect(doc.documentElement.hidden).toBe(true);
  } finally { letGo(); }
});
it("stops a plain Back or Forward before the router hears it, then reloads, so no route restore starts for the reload to abort", async () => {
  const ready = vi.fn(); dispose = watchPrivateWorkspace("alice", ready); await flush();
  // Registered after the workspace, as the router's own listener is.
  const router = vi.fn();
  win.addEventListener("popstate", router);
  try {
    win.dispatchEvent(new Event("popstate"));
    expect(router).not.toHaveBeenCalled();
    expect(win.location.replace).toHaveBeenCalledWith("http://instance.test/maps/copied-id");
    // The page hides as the document goes, with no private request outliving it.
    win.dispatchEvent(new Event("pagehide"));
    expect(doc.documentElement.hidden).toBe(true); expect(doc.title).toBe("Dezfil");
    await expect(win.fetch("/api/maps")).rejects.toMatchObject({ name: "AbortError" });
  } finally { win.removeEventListener("popstate", router); }
});
/** A session read the test answers by hand, after the workspace's first one. */
function heldSession() {
  const answers: ((response: Response) => void)[] = [];
  const transport = vi.fn<typeof fetch>(async () => Response.json({ account: { id: "alice" } }));
  win.fetch = transport;
  const hold = () => transport.mockImplementation(() => new Promise<Response>(resolve => { answers.push(resolve); }));
  const answer = (id: string) => answers.shift()!(Response.json({ account: { id } }));
  return { transport, hold, answer };
}
/** A traversal carrying the state the router restores from. */
const step = () => Object.assign(new Event("popstate"), { state: { tree: "the arrival's" } });

it("holds a Back or Forward the page keeps from the router until the session names the document's account, then hands it on", async () => {
  const session = heldSession();
  const ready = vi.fn(); dispose = watchPrivateWorkspace("alice", ready); await flush();
  // Added after the workspace's, as the router's own listener is.
  const router = vi.fn((event: Event) => (event as PopStateEvent).state);
  win.addEventListener("popstate", router);
  const letGo = keepTraversals(() => true);
  try {
    session.hold();
    win.dispatchEvent(step());
    await flush();
    expect(router).not.toHaveBeenCalled();
    expect(doc.documentElement.hidden).toBe(false);
    session.answer("alice"); await flush();
    expect(router).toHaveBeenCalledOnce();
    expect(router.mock.results[0].value).toEqual({ tree: "the arrival's" });
    expect(win.location.replace).not.toHaveBeenCalled();
    expect(doc.documentElement.hidden).toBe(false); expect(ready).toHaveBeenLastCalledWith(true);
  } finally { letGo(); win.removeEventListener("popstate", router); }
});
it("stops a step a page takes before the router hears it and hands it to that page once the session agrees, ending nothing", async () => {
  const session = heldSession();
  const ready = vi.fn(); dispose = watchPrivateWorkspace("alice", ready); await flush();
  // Listeners on the window run in the order they were added, capture or not: the router's is added after the
  // workspace's and before the page's own, which mounts later.
  const router = vi.fn();
  const page = vi.fn((event: Event) => { event.stopImmediatePropagation(); });
  win.addEventListener("popstate", router);
  win.addEventListener("popstate", page, true);
  const take = vi.fn();
  const letGo = takeTraversals(() => true, take);
  try {
    session.hold();
    const taken = step();
    win.dispatchEvent(taken);
    await flush();
    expect(take).not.toHaveBeenCalled();
    session.answer("alice"); await flush();
    expect(take).toHaveBeenCalledExactlyOnceWith(taken);
    expect(router).not.toHaveBeenCalled();
    expect(page).not.toHaveBeenCalled();
    expect(win.location.replace).not.toHaveBeenCalled();
    expect(doc.documentElement.hidden).toBe(false); expect(ready).toHaveBeenLastCalledWith(true);
  } finally { letGo(); win.removeEventListener("popstate", router); win.removeEventListener("popstate", page, true); }
});
it.each(["keeps", "takes"] as const)("ends the document when a late session read for a step the page %s names another account, the step never handed on", async how => {
  const session = heldSession();
  const ready = vi.fn(); dispose = watchPrivateWorkspace("alice", ready); await flush();
  const router = vi.fn(), take = vi.fn();
  win.addEventListener("popstate", router);
  const letGo = how === "keeps" ? keepTraversals(() => true) : takeTraversals(() => true, take);
  try {
    session.hold();
    win.dispatchEvent(step());
    await flush();
    session.answer("bob"); await flush();
    expect(win.location.replace).toHaveBeenCalledOnce();
    expect(doc.documentElement.hidden).toBe(true); expect(ready).toHaveBeenLastCalledWith(false);
    expect(router).not.toHaveBeenCalled(); expect(take).not.toHaveBeenCalled();
  } finally { letGo(); win.removeEventListener("popstate", router); }
});
it("hides the page only when the session read for a held step is slow, and shows it again when the read agrees", async () => {
  const session = heldSession();
  const ready = vi.fn(); dispose = watchPrivateWorkspace("alice", ready); await flush();
  const router = vi.fn();
  win.addEventListener("popstate", router);
  const letGo = keepTraversals(() => true);
  vi.useFakeTimers();
  try {
    session.hold();
    win.dispatchEvent(step());
    await vi.advanceTimersByTimeAsync(TRAVERSAL_GRACE_MS - 1);
    expect(doc.documentElement.hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(doc.documentElement.hidden).toBe(true);
    session.answer("alice"); await vi.advanceTimersByTimeAsync(0);
    expect(doc.documentElement.hidden).toBe(false);
    expect(router).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); letGo(); win.removeEventListener("popstate", router); }
});
it("never hides the page when the session read for a held step answers within the grace", async () => {
  const session = heldSession();
  const ready = vi.fn(); dispose = watchPrivateWorkspace("alice", ready); await flush();
  const hidden: boolean[] = [];
  let value = doc.documentElement.hidden;
  Object.defineProperty(doc.documentElement, "hidden", { get: () => value, set: next => { hidden.push(next); value = next; }, configurable: true });
  const letGo = keepTraversals(() => true);
  vi.useFakeTimers();
  try {
    session.hold();
    win.dispatchEvent(step());
    await vi.advanceTimersByTimeAsync(TRAVERSAL_GRACE_MS / 2);
    session.answer("alice");
    await vi.advanceTimersByTimeAsync(TRAVERSAL_GRACE_MS * 4);
    expect(hidden).not.toContain(true);
    expect(value).toBe(false);
  } finally { vi.useRealTimers(); letGo(); }
});
it.each(["keeps", "takes"] as const)("reads the session for a Back or Forward the page %s, and ends the document when another account is signed in", async how => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({ account: { id: "alice" } }));
  win.fetch = transport;
  const ready = vi.fn(); dispose = watchPrivateWorkspace("alice", ready); await flush();
  const letGo = how === "keeps" ? keepTraversals(() => true) : takeTraversals(() => true, () => {});
  try {
    // The session changed with no notice reaching this tab.
    transport.mockImplementation(async () => Response.json({ account: { id: "bob" } }));
    win.dispatchEvent(new Event("popstate"));
    await flush();
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenLastCalledWith("/api/auth/session", expect.objectContaining({ cache: "no-store" }));
    expect(win.location.replace).toHaveBeenCalledOnce();
    expect(doc.documentElement.hidden).toBe(true); expect(ready).toHaveBeenLastCalledWith(false);
  } finally { letGo(); }
});
it.each([
  ["signed out", async () => Response.json({ error: { code: "unauthorized" } }, { status: 401 })],
  ["unreachable", async () => { throw new TypeError("Failed to fetch"); }],
] as const)("ends the document on a kept Back or Forward when the session read finds it %s", async (_case, answer) => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({ account: { id: "alice" } }));
  win.fetch = transport;
  const ready = vi.fn(); dispose = watchPrivateWorkspace("alice", ready); await flush();
  const letGo = keepTraversals(() => true);
  try {
    transport.mockImplementation(answer);
    win.dispatchEvent(new Event("popstate"));
    await flush();
    expect(win.location.replace).toHaveBeenCalledOnce();
    expect(doc.documentElement.hidden).toBe(true);
  } finally { letGo(); }
});
it("keeps a kept step's page shown while the session is read, and keeps the document when the session still names its account", async () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({ account: { id: "alice" } }));
  win.fetch = transport;
  const ready = vi.fn(); dispose = watchPrivateWorkspace("alice", ready); await flush();
  const letGo = keepTraversals(() => true);
  try {
    win.dispatchEvent(new Event("popstate"));
    expect(doc.documentElement.hidden).toBe(false);
    await flush();
    expect(transport).toHaveBeenCalledTimes(2);
    expect(win.location.replace).not.toHaveBeenCalled();
    expect(doc.documentElement.hidden).toBe(false); expect(ready).toHaveBeenLastCalledWith(true);
  } finally { letGo(); }
});
it("ends the document on a step a page took and lets go, and offers that only while it watches", async () => {
  const ready = vi.fn(); dispose = watchPrivateWorkspace("alice", ready); await flush();
  expect(letTraversalGo()).toBe(true);
  expect(win.location.replace).toHaveBeenCalledWith("http://instance.test/maps/copied-id");
  win.dispatchEvent(new Event("pagehide"));
  expect(doc.documentElement.hidden).toBe(true);
  dispose(); dispose = undefined;
  expect(letTraversalGo()).toBe(false);
  expect(win.location.replace).toHaveBeenCalledOnce();
});
it("reloads a Back or Forward once the page that claimed it has gone", async () => {
  const ready = vi.fn(); dispose = watchPrivateWorkspace("alice", ready); await flush();
  keepTraversals(() => true)();
  win.dispatchEvent(new Event("popstate"));
  expect(win.location.replace).toHaveBeenCalledOnce();
});
it("refuses an old server payload and removes old-tab locators before a new account mounts", async () => {
  writeStored(SQL_KEYS.draft, "Alice's SQL");
  sessionStorage.setItem(LOCATOR_KEY, JSON.stringify({ id: "alice-receipt", message: "Alice's message" }));
  win.fetch = vi.fn(async () => Response.json({ account: { id: "bob" } }));
  const ready = vi.fn(); dispose = watchPrivateWorkspace("alice", ready); await flush();
  expect(ready).not.toHaveBeenCalledWith(true); expect(doc.documentElement.hidden).toBe(true);
  dispose(); dispose = undefined;
  openPrivateState("bob");
  expect(readStored(SQL_KEYS.draft, null)).toBeNull(); expect(sessionStorage.getItem(LOCATOR_KEY)).toBeNull();
});
it("rechecks focus and visibility with storage unavailable, retaining valid same-account memory", async () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({ account: { id: "alice" } }));
  win.fetch = transport;
  vi.stubGlobal("localStorage", undefined); vi.stubGlobal("sessionStorage", undefined);
  dispose = watchPrivateWorkspace("alice", vi.fn()); await flush();
  conversation.set({ input: "in-memory draft" });
  win.dispatchEvent(new Event("focus")); await flush();
  expect(conversation.get().input).toBe("in-memory draft");
  doc.visibilityState = "hidden"; doc.dispatchEvent(new Event("visibilitychange")); expect(doc.documentElement.hidden).toBe(true);
  transport.mockResolvedValue(Response.json({ account: { id: "bob" } }));
  doc.visibilityState = "visible"; doc.dispatchEvent(new Event("visibilitychange")); await flush();
  expect(doc.documentElement.hidden).toBe(true); expect(conversation.get().input).toBe("");
  expect(win.location.replace).toHaveBeenCalledOnce();
});
it("never remounts when an old session check arrives after account retirement", async () => {
  let finish!: (value: Response) => void;
  win.fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  const ready = vi.fn(); dispose = watchPrivateWorkspace("alice", ready);
  accountChanged();
  finish(Response.json({ account: { id: "alice" } })); await flush();
  expect(ready).not.toHaveBeenCalledWith(true); expect(doc.documentElement.hidden).toBe(true);
  expect(win.location.replace).toHaveBeenCalledOnce();
});
