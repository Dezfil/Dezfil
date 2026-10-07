import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultLook, type Look } from "@/lib/look";
import { closePrivateState } from "../auth/private-state";
import { endLookSession, lookSession, openLookSession } from "./look-session";
import { unitKey } from "./look-tab";

/**
 * The look's session at workspace scope: one per account, the document's
 * root following what its cards show whether or not the tab is mounted,
 * and nothing of it reaching another account. The root is a plain
 * attribute map and the server a fake the test answers by hand.
 */

function fakeRoot() {
  const attributes = new Map<string, string>();
  const root = {
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    removeAttribute: (name: string) => attributes.delete(name),
    getAttribute: (name: string) => attributes.get(name) ?? null,
  } as unknown as Element;
  return { root, attributes: () => Object.fromEntries(attributes) };
}

function fakeServer(initial: Partial<Look>) {
  let stored: Look = { ...defaultLook(), ...initial };
  const calls: { accept: () => void; fail: () => void }[] = [];
  const send = vi.fn((patch: Partial<Look>) => new Promise<Look>((resolve, reject) => {
    calls.push({
      accept: () => { stored = { ...stored, ...patch }; resolve({ ...stored }); },
      fail: () => reject(new Error("Dezfil could not reach the server.")),
    });
  }));
  return { send, calls, stored: () => stored };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { endLookSession(); vi.useRealTimers(); });

describe("the look's session", () => {
  it("stamps the root with what it holds, and follows every pick and answer without any tab", async () => {
    const server = fakeServer({ color: "harbor" }), { root, attributes } = fakeRoot();
    const session = openLookSession("ada", server.stored(), server.send, root);
    expect(attributes()).toEqual({ "data-look-color": "harbor" });
    session.units[0].choose(unitKey("color"), "slate");
    expect(attributes()).toEqual({ "data-look-color": "slate" });
    server.calls[0].fail(); await vi.advanceTimersByTimeAsync(0);
    expect(attributes()).toEqual({ "data-look-color": "harbor" });
  });

  it("is the same session for the same account, opened once", () => {
    const server = fakeServer({}), { root } = fakeRoot();
    const first = openLookSession("ada", server.stored(), server.send, root);
    expect(lookSession("ada")).toBe(first);
    expect(openLookSession("ada", { ...defaultLook(), color: "slate" }, server.send, root)).toBe(first);
    expect(lookSession("bob")).toBeNull();
  });

  it("ends when another account opens one: the first one's late answer never touches the root", async () => {
    const ada = fakeServer({}), bob = fakeServer({ corners: "soft" }), { root, attributes } = fakeRoot();
    openLookSession("ada", ada.stored(), ada.send, root).units[2].choose(unitKey("font"), "system");
    expect(attributes()).toEqual({ "data-look-font": "system" });
    openLookSession("bob", bob.stored(), bob.send, root);
    expect(lookSession("ada")).toBeNull();
    expect(attributes()).toEqual({ "data-look-corners": "soft" });
    ada.calls[0].accept(); await vi.advanceTimersByTimeAsync(0);
    expect(attributes()).toEqual({ "data-look-corners": "soft" });
  });

  it("ends when the workspace's private state closes, as at a change of account", async () => {
    const server = fakeServer({}), { root, attributes } = fakeRoot();
    openLookSession("ada", server.stored(), server.send, root).units[0].choose(unitKey("color"), "heather");
    closePrivateState();
    expect(lookSession("ada")).toBeNull();
    server.calls[0].fail(); await vi.advanceTimersByTimeAsync(0);
    expect(attributes()).toEqual({ "data-look-color": "heather" });
  });
});
