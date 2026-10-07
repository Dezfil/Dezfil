import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closePrivateState, openPrivateState } from "../auth/private-state";
import { LAST_TAB_KEY, readLastTab, writeLastTab } from "./last-tab";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

let session: ReturnType<typeof memoryStorage>;
beforeEach(() => {
  session = memoryStorage();
  vi.stubGlobal("sessionStorage", session);
  vi.stubGlobal("localStorage", memoryStorage());
  openPrivateState("ada");
});
afterEach(() => vi.unstubAllGlobals());

describe("the last open Settings tab", () => {
  it("is remembered for this browser session, in the session's own store", () => {
    expect(readLastTab()).toBeNull();
    writeLastTab("limits");
    expect(session.values.get(LAST_TAB_KEY)).toBe("limits");
    expect(readLastTab()).toBe("limits");
    writeLastTab("tokens");
    expect(readLastTab()).toBe("tokens");
  });

  it("is forgotten with the account's other private memory", () => {
    writeLastTab("system");
    openPrivateState("bo");
    expect(readLastTab()).toBeNull();
  });

  it("is neither read nor written while private memory is closed", () => {
    writeLastTab("general");
    closePrivateState();
    expect(readLastTab()).toBeNull();
    writeLastTab("limits");
    openPrivateState("ada");
    expect(readLastTab()).toBe("general");
  });

  it("leaves the page working when the store refuses", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    });
    expect(() => writeLastTab("limits")).not.toThrow();
    expect(readLastTab()).toBeNull();
  });
});
