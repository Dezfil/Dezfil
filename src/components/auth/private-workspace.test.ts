import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { watchPrivateWorkspace } from "./private-workspace";
import { endTraversals, keepTraversals } from "./kept-traversals";
import { ACCOUNT_STORAGE_KEY, accountChanged, openPrivateState } from "./private-state";
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
it.each(["storage", "popstate", "pageshow"])("conceals and reloads a %s restore instead of reusing private state", async kind => {
  const ready = vi.fn(); dispose = watchPrivateWorkspace("alice", ready); await flush();
  const event = new Event(kind);
  if (kind === "storage") Object.defineProperty(event, "key", { value: ACCOUNT_STORAGE_KEY });
  if (kind === "pageshow") { win.dispatchEvent(new Event("pagehide")); expect(doc.documentElement.hidden).toBe(true); Object.defineProperty(event, "persisted", { value: true }); }
  win.dispatchEvent(event);
  expect(doc.documentElement.hidden).toBe(true); expect(ready).toHaveBeenLastCalledWith(false);
  expect(win.location.replace).toHaveBeenCalledWith("http://instance.test/maps/copied-id");
  await expect(win.fetch("/api/maps")).rejects.toMatchObject({ name: "AbortError" });
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
    expect(doc.documentElement.hidden).toBe(true);
  } finally { letGo(); }
});
it("ends the document on a Back or Forward the page on screen sent to leave, before anyone after it hears the step", async () => {
  const ready = vi.fn(); dispose = watchPrivateWorkspace("alice", ready); await flush();
  // Registered after the workspace, as the router's own listener is.
  const after = vi.fn();
  win.addEventListener("popstate", after);
  let sent = false;
  const letGo = endTraversals(() => sent);
  const kept = keepTraversals(() => true);
  try {
    // A step the page keeps reaches every listener and ends nothing.
    win.dispatchEvent(new Event("popstate"));
    expect(after).toHaveBeenCalledOnce();
    expect(win.location.replace).not.toHaveBeenCalled();
    sent = true;
    win.dispatchEvent(new Event("popstate"));
    expect(after).toHaveBeenCalledOnce();
    expect(win.location.replace).toHaveBeenCalledWith("http://instance.test/maps/copied-id");
    expect(doc.documentElement.hidden).toBe(true); expect(ready).toHaveBeenLastCalledWith(false);
  } finally { letGo(); kept(); win.removeEventListener("popstate", after); }
});
it("hears every Back or Forward as before once the page that sent one has gone", async () => {
  dispose = watchPrivateWorkspace("alice", vi.fn()); await flush();
  const after = vi.fn();
  win.addEventListener("popstate", after);
  endTraversals(() => true)();
  win.dispatchEvent(new Event("popstate"));
  expect(after).toHaveBeenCalledOnce();
  expect(win.location.replace).toHaveBeenCalledOnce();
  win.removeEventListener("popstate", after);
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
