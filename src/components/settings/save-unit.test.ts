import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FADE_MS, rowRefusals, SAVED_HOLD_MS, SaveUnit, SETTLE_MS, UNDO_MS, WriteRefusal, type UnitControl, type Value } from "./save-unit";
import { LeaveGuard } from "./leave-guard";

/**
 * The save unit's rules, against a fake server whose every answer the
 * test gives by hand: it accepts (storing what was sent, a null as the
 * default, and reporting every value back), refuses by code, fails like
 * a lost connection, or never answers.
 */

const DEFAULTS: Record<string, Value> = {
  landingPage: "home", signInMessage: "", lostPasswordContact: "", queryTimeoutS: 60, operationTimeoutS: 600, previewRows: 1000,
};

function fakeServer(initial: Record<string, Value> = {}, report: (key: string, value: Value) => Value = (_, value) => value) {
  const stored: Record<string, Value> = { ...DEFAULTS, ...initial };
  const calls: {
    patch: Record<string, Value>;
    accept: () => void;
    refuse: (code: string, message: string, status?: number) => void;
    fail: () => void;
  }[] = [];
  const write = vi.fn((patch: Record<string, Value>) => new Promise<Record<string, Value>>((resolve, reject) => {
    calls.push({
      patch: { ...patch },
      accept: () => {
        for (const [key, value] of Object.entries(patch)) stored[key] = value === null ? DEFAULTS[key] : report(key, value);
        resolve({ ...stored });
      },
      refuse: (code, message, status = 400) => reject(new WriteRefusal(code, message, status)),
      fail: () => reject(new Error("Dezfil could not reach the server.")),
    });
  }));
  return { write, calls, stored };
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const landing: UnitControl = { key: "landingPage", kind: "choice", defaultValue: "home" };
const message: UnitControl = { key: "signInMessage", kind: "text", defaultValue: "" };
const contact: UnitControl = { key: "lostPasswordContact", kind: "text", defaultValue: "" };
const query: UnitControl = { key: "queryTimeoutS", kind: "number", min: 5, max: 600, defaultValue: 60 };
const runs: UnitControl = { key: "operationTimeoutS", kind: "number", min: 30, max: 7200, defaultValue: 600 };

function signIn(server = fakeServer(), extra: UnitControl[] = []) {
  return new SaveUnit({
    title: "Sign-in", controls: [message, contact, landing, ...extra], write: server.write,
    kept: { signInMessage: server.stored.signInMessage, lostPasswordContact: server.stored.lostPasswordContact, landingPage: server.stored.landingPage },
  });
}
function limits(server = fakeServer()) {
  return new SaveUnit({
    title: "Queries", controls: [query, runs], write: server.write,
    kept: { queryTimeoutS: server.stored.queryTimeoutS, operationTimeoutS: server.stored.operationTimeoutS },
  });
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("a value kept as you go", () => {
  it("keeps a changed choice without a Save, and shows Saved only on the write's response", async () => {
    const server = fakeServer(), unit = signIn(server);
    unit.choose("landingPage", "maps");
    expect(server.calls.map(call => call.patch)).toEqual([{ landingPage: "maps" }]);
    expect(unit.snapshot.saveLine).toBe(false);
    expect(unit.snapshot.saved).toEqual([]);
    server.calls[0].accept(); await flush();
    expect(unit.snapshot.saved).toEqual(["landingPage"]);
    expect(unit.snapshot.kept.landingPage).toBe("maps");
    await vi.advanceTimersByTimeAsync(SAVED_HOLD_MS);
    expect(unit.snapshot.saved).toEqual([]);
  });

  it("never shows Saved when the server refuses the write", async () => {
    const server = fakeServer(), unit = signIn(server);
    unit.choose("landingPage", "maps");
    server.calls[0].refuse("setting_locked", "landingPage: Locked by DEZFIL_LANDING.", 409); await flush();
    expect(unit.snapshot.saved).toEqual([]);
    await vi.advanceTimersByTimeAsync(SAVED_HOLD_MS * 2);
    expect(unit.snapshot.saved).toEqual([]);
    expect(unit.snapshot.kept.landingPage).toBe("home");
    expect(unit.snapshot.values.landingPage).toBe("home");
  });

  it("never shows Saved while the write has not answered", async () => {
    const server = fakeServer(), unit = signIn(server);
    unit.choose("landingPage", "sql");
    expect(unit.snapshot.saved).toEqual([]);
    await vi.advanceTimersByTimeAsync(SAVED_HOLD_MS / 2);
    expect(unit.snapshot.saved).toEqual([]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(server.calls).toHaveLength(1);
    expect(unit.snapshot.saved).toEqual([]);
    expect(unit.snapshot.kept.landingPage).toBe("home");
    expect(unit.snapshot.values.landingPage).toBe("sql");
  });

  it("keeps a stepped number at once, sending only the value the steps settle on", async () => {
    const server = fakeServer(), unit = limits(server);
    for (const value of ["61", "62", "63"]) { unit.step("queryTimeoutS", value); await vi.advanceTimersByTimeAsync(SETTLE_MS / 3); }
    expect(server.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(server.calls.map(call => call.patch)).toEqual([{ queryTimeoutS: 63 }]);
    server.calls[0].accept(); await flush();
    expect(unit.snapshot.kept.queryTimeoutS).toBe(63);
    expect(unit.snapshot.saved).toEqual(["queryTimeoutS"]);
  });

  it("settles steps made while a write is in flight on the last value, never snapping the field back", async () => {
    const server = fakeServer(), unit = limits(server);
    unit.step("queryTimeoutS", "61"); await vi.advanceTimersByTimeAsync(SETTLE_MS);
    unit.step("queryTimeoutS", "62"); unit.step("queryTimeoutS", "63"); await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(server.calls).toHaveLength(1);
    server.calls[0].accept(); await flush();
    expect(unit.snapshot.values.queryTimeoutS).toBe("63");
    expect(unit.snapshot.saved).toEqual([]);
    expect(server.calls.map(call => call.patch)).toEqual([{ queryTimeoutS: 61 }, { queryTimeoutS: 63 }]);
    server.calls[1].accept(); await flush();
    expect(unit.snapshot.kept.queryTimeoutS).toBe(63);
    expect(unit.snapshot.saved).toEqual(["queryTimeoutS"]);
  });

  it("does not write a number stepped back to its kept value", async () => {
    const server = fakeServer(), unit = limits(server);
    unit.step("queryTimeoutS", "61"); unit.step("queryTimeoutS", "60");
    await vi.advanceTimersByTimeAsync(SETTLE_MS * 4);
    expect(server.calls).toHaveLength(0);
  });

  it("keeps a typed number on Enter or on leaving the field, never while it is typed, and never waits for Save", async () => {
    const server = fakeServer(), unit = limits(server);
    unit.edit("queryTimeoutS", "12");
    unit.edit("queryTimeoutS", "120");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(server.calls).toHaveLength(0);
    expect(unit.snapshot.saveLine).toBe(false);
    expect(unit.snapshot.dirty).toBe(false);
    unit.commit("queryTimeoutS");
    expect(server.calls.map(call => call.patch)).toEqual([{ queryTimeoutS: 120 }]);
  });

  it("shows the value the response reports as kept", async () => {
    const server = fakeServer({}, (key, value) => typeof value === "string" ? value.trim() : value), unit = signIn(server);
    unit.edit("signInMessage", "  Ask the GIS team.  ");
    unit.save();
    server.calls[0].accept(); await flush();
    expect(unit.snapshot.values.signInMessage).toBe("Ask the GIS team.");
    expect(unit.snapshot.kept.signInMessage).toBe("Ask the GIS team.");
    expect(unit.snapshot.saveLine).toBe(false);
  });
});

describe("typed text waits for the card's Save", () => {
  it("shows Save and Cancel only while typed text differs from what was saved", () => {
    const unit = signIn();
    expect(unit.snapshot.saveLine).toBe(false);
    unit.edit("signInMessage", "Hello");
    expect(unit.snapshot.saveLine).toBe(true);
    unit.edit("signInMessage", "");
    expect(unit.snapshot.saveLine).toBe(false);
  });

  it("treats an empty field and a value never set as the same text", () => {
    const unit = new SaveUnit({ title: "Instance", controls: [{ key: "instanceName", kind: "text" }], kept: { instanceName: null }, write: fakeServer().write });
    expect(unit.snapshot.values.instanceName).toBe("");
    expect(unit.snapshot.saveLine).toBe(false);
  });

  it("writes every changed key in one request, then returns focus to the field", async () => {
    const server = fakeServer(), unit = signIn(server);
    unit.edit("signInMessage", "Use your work email.");
    unit.edit("lostPasswordContact", "the GIS team");
    unit.save();
    expect(server.calls.map(call => call.patch)).toEqual([{ signInMessage: "Use your work email.", lostPasswordContact: "the GIS team" }]);
    expect(unit.snapshot.busy).toBe(true);
    expect(unit.snapshot.saved).toEqual([]);
    server.calls[0].accept(); await flush();
    expect(unit.snapshot.busy).toBe(false);
    expect(unit.snapshot.saveLine).toBe(false);
    expect([...unit.snapshot.saved].sort()).toEqual(["lostPasswordContact", "signInMessage"]);
    expect(unit.snapshot.focus).toMatchObject({ to: "field", key: "lostPasswordContact" });
  });

  it("puts every control back to what was saved on Cancel", () => {
    const unit = signIn(fakeServer({ signInMessage: "Welcome." }));
    unit.edit("signInMessage", "Changed");
    unit.edit("lostPasswordContact", "someone");
    unit.cancel();
    expect(unit.snapshot.values).toMatchObject({ signInMessage: "Welcome.", lostPasswordContact: "" });
    expect(unit.snapshot.saveLine).toBe(false);
    expect(unit.snapshot.focus).toMatchObject({ to: "field", key: "lostPasswordContact" });
  });

  it("keeps the text unsaved when the Save fails, with Try again", async () => {
    const server = fakeServer(), unit = signIn(server);
    unit.edit("signInMessage", "Hello");
    unit.save();
    server.calls[0].fail(); await flush();
    expect(unit.snapshot.saveLine).toBe(true);
    expect(unit.snapshot.note).toEqual({ message: "Dezfil could not reach the server.", retry: true });
    expect(unit.snapshot.saved).toEqual([]);
    unit.retry();
    expect(server.calls.map(call => call.patch)).toEqual([{ signInMessage: "Hello" }, { signInMessage: "Hello" }]);
    server.calls[1].accept(); await flush();
    expect(unit.snapshot.note).toBeNull();
    expect(unit.snapshot.saved).toEqual(["signInMessage"]);
  });
});

describe("refusals", () => {
  it("draws the red line under the row a refusal names, with the refusal's words, and keeps nothing", async () => {
    const server = fakeServer(), unit = limits(server);
    unit.step("queryTimeoutS", "600"); await vi.advanceTimersByTimeAsync(SETTLE_MS);
    server.calls[0].refuse("invalid_request",
      "queryTimeoutS must be less than operationTimeoutS. The effective timeout limits do not satisfy this relationship."); await flush();
    expect(unit.snapshot.errors).toEqual({
      queryTimeoutS: "queryTimeoutS must be less than operationTimeoutS. The effective timeout limits do not satisfy this relationship.",
    });
    expect(unit.snapshot.note).toBeNull();
    expect(unit.snapshot.kept.queryTimeoutS).toBe(60);
    expect(unit.snapshot.values.queryTimeoutS).toBe("600");
    expect(unit.snapshot.saved).toEqual([]);
    unit.edit("queryTimeoutS", "59");
    expect(unit.snapshot.errors).toEqual({});
  });

  it("puts each named reason under its own row", async () => {
    const server = fakeServer(), unit = signIn(server);
    unit.edit("signInMessage", "x".repeat(300)); unit.edit("lostPasswordContact", "y".repeat(130));
    unit.save();
    server.calls[0].refuse("invalid_request", "signInMessage: Expected at most 280 characters. lostPasswordContact: Expected at most 120 characters."); await flush();
    expect(unit.snapshot.errors).toEqual({
      signInMessage: "Expected at most 280 characters.", lostPasswordContact: "Expected at most 120 characters.",
    });
    expect(unit.snapshot.saveLine).toBe(true);
    expect(unit.snapshot.note).toBeNull();
  });

  it("refuses an out-of-range number before any request", async () => {
    const server = fakeServer(), unit = limits(server);
    unit.step("queryTimeoutS", "601"); await vi.advanceTimersByTimeAsync(SETTLE_MS * 2);
    expect(unit.snapshot.errors.queryTimeoutS).toBe("Enter a number from 5 to 600.");
    for (const [typed, words] of [["4", "Enter a number from 5 to 600."], ["", "Enter a number."], ["ten", "Enter a number."], ["7.5", "Enter a whole number."]]) {
      unit.edit("queryTimeoutS", typed); unit.commit("queryTimeoutS");
      expect(unit.snapshot.errors.queryTimeoutS).toBe(words);
    }
    expect(server.calls).toHaveLength(0);
    expect(unit.snapshot.kept.queryTimeoutS).toBe(60);
  });

  it("draws the error note for a refusal naming no row, with Try again only where a retry makes sense", async () => {
    const cases: [(call: ReturnType<typeof fakeServer>["calls"][number]) => void, boolean][] = [
      [call => call.refuse("setting_locked", "queryTimeoutS: Locked by DEZFIL_QUERY_TIMEOUT_S.", 409), false],
      [call => call.refuse("unauthorized", "Sign in again to continue.", 401), false],
      [call => call.refuse("forbidden", "Only admins can change instance settings.", 403), false],
      [call => call.refuse("internal", "Something went wrong.", 500), true],
      [call => call.fail(), true],
    ];
    for (const [answer, retry] of cases) {
      const server = fakeServer(), unit = limits(server);
      unit.step("queryTimeoutS", "90"); await vi.advanceTimersByTimeAsync(SETTLE_MS);
      answer(server.calls[0]); await flush();
      expect(unit.snapshot.errors).toEqual({});
      expect(unit.snapshot.note?.retry).toBe(retry);
      expect(unit.snapshot.values.queryTimeoutS).toBe("60");
      expect(unit.snapshot.saved).toEqual([]);
    }
  });

  it("tries a refused keep again with the value that was refused", async () => {
    const server = fakeServer(), unit = signIn(server);
    unit.choose("landingPage", "data");
    server.calls[0].fail(); await flush();
    unit.retry();
    expect(server.calls.map(call => call.patch)).toEqual([{ landingPage: "data" }, { landingPage: "data" }]);
    expect(unit.snapshot.values.landingPage).toBe("data");
    server.calls[1].accept(); await flush();
    expect(unit.snapshot.kept.landingPage).toBe("data");
    expect(unit.snapshot.note).toBeNull();
  });

  it("reads which rows a refusal names", () => {
    expect(rowRefusals("a: One. b: Expected one of: home, maps.", ["a", "b"])).toEqual({ a: "One.", b: "Expected one of: home, maps." });
    expect(rowRefusals("Unknown setting key at position 1.", ["a"])).toEqual({});
    expect(rowRefusals("c: Not this card's.", ["a"])).toEqual({});
    expect(rowRefusals("queryTimeoutS must be less than operationTimeoutS.", ["operationTimeoutS"]))
      .toEqual({ operationTimeoutS: "queryTimeoutS must be less than operationTimeoutS." });
  });
});

describe("Reset to defaults, and Undo", () => {
  async function changed(server = fakeServer({ landingPage: "maps", signInMessage: "Hi" })) {
    const unit = signIn(server);
    return { server, unit };
  }

  it("offers Reset only while a kept value differs from the read's defaults", async () => {
    const server = fakeServer(), unit = signIn(server);
    expect(unit.snapshot.slot).toBeNull();
    unit.edit("signInMessage", "Typed, not saved");
    expect(unit.snapshot.slot).toBeNull();
    unit.choose("landingPage", "maps");
    expect(unit.snapshot.slot).toBeNull();
    server.calls[0].accept(); await flush();
    expect(unit.snapshot.slot).toBe("reset");
  });

  it("returns the card's editable, unlocked controls to their defaults in one write, then offers Undo with focus on it", async () => {
    const { server, unit } = await changed();
    expect(unit.snapshot.slot).toBe("reset");
    unit.reset();
    expect(server.calls.map(call => call.patch)).toEqual([{ signInMessage: null, landingPage: null }]);
    server.calls[0].accept(); await flush();
    expect(unit.snapshot.kept).toMatchObject({ signInMessage: "", landingPage: "home" });
    expect(unit.snapshot.values).toMatchObject({ signInMessage: "", landingPage: "home" });
    expect(unit.snapshot.slot).toBe("undo");
    expect(unit.snapshot.saved).toEqual([]);
    expect(unit.snapshot.focus).toMatchObject({ to: "undo" });
  });

  it("writes the previous values back in one write on Undo, and returns focus to Reset", async () => {
    const { server, unit } = await changed();
    unit.reset(); server.calls[0].accept(); await flush();
    unit.undo();
    expect(server.calls[1].patch).toEqual({ signInMessage: "Hi", landingPage: "maps" });
    server.calls[1].accept(); await flush();
    expect(unit.snapshot.kept).toMatchObject({ signInMessage: "Hi", landingPage: "maps" });
    expect(unit.snapshot.slot).toBe("reset");
    expect(unit.snapshot.focus).toMatchObject({ to: "reset" });
  });

  it("lets Undo go after six seconds, fading before the slot shows the card as it is", async () => {
    const { server, unit } = await changed();
    unit.reset(); server.calls[0].accept(); await flush();
    await vi.advanceTimersByTimeAsync(UNDO_MS - 1);
    expect(unit.snapshot).toMatchObject({ slot: "undo", undoLeaving: false });
    await vi.advanceTimersByTimeAsync(1);
    expect(unit.snapshot).toMatchObject({ slot: "undo", undoLeaving: true });
    await vi.advanceTimersByTimeAsync(FADE_MS);
    expect(unit.snapshot).toMatchObject({ slot: null, undoLeaving: false });
  });

  it("holds Undo while focus or the pointer is on it", async () => {
    const { server, unit } = await changed();
    unit.reset(); server.calls[0].accept(); await flush();
    await vi.advanceTimersByTimeAsync(2000);
    unit.holdUndo("focus", true);
    await vi.advanceTimersByTimeAsync(UNDO_MS * 3);
    expect(unit.snapshot).toMatchObject({ slot: "undo", undoLeaving: false });
    unit.holdUndo("pointer", true);
    unit.holdUndo("focus", false);
    await vi.advanceTimersByTimeAsync(UNDO_MS);
    expect(unit.snapshot.slot).toBe("undo");
    unit.holdUndo("pointer", false);
    expect(unit.snapshot.undoLeaving).toBe(true);
    await vi.advanceTimersByTimeAsync(FADE_MS);
    expect(unit.snapshot.slot).toBeNull();
  });

  it("lets Undo go at a new change in the card, or when the tab is left", async () => {
    const first = await changed();
    first.unit.reset(); first.server.calls[0].accept(); await flush();
    first.unit.choose("landingPage", "sql");
    expect(first.unit.snapshot.slot).not.toBe("undo");
    const second = await changed();
    second.unit.reset(); second.server.calls[0].accept(); await flush();
    second.unit.leave();
    expect(second.unit.snapshot.slot).toBeNull();
  });

  it("offers no Undo when the Reset is refused", async () => {
    const { server, unit } = await changed();
    unit.reset();
    server.calls[0].fail(); await flush();
    expect(unit.snapshot.slot).toBe("reset");
    expect(unit.snapshot.note?.retry).toBe(true);
    expect(unit.snapshot.kept).toMatchObject({ signInMessage: "Hi", landingPage: "maps" });
  });
});

describe("a setting pinned by the server's environment", () => {
  const pinned: UnitControl = { key: "previewRows", kind: "number", min: 10, max: 100000, defaultValue: 1000, locked: true };

  it("joins neither Save, Reset nor the guard", async () => {
    const server = fakeServer({ previewRows: 5000 });
    const unit = new SaveUnit({ title: "Results", controls: [pinned], kept: { previewRows: 5000 }, write: server.write });
    expect(unit.snapshot.slot).toBeNull();
    unit.edit("previewRows", "20"); unit.commit("previewRows"); unit.step("previewRows", "21");
    await vi.advanceTimersByTimeAsync(SETTLE_MS * 2);
    expect(server.calls).toHaveLength(0);
    expect(unit.snapshot.values.previewRows).toBe("5000");
    expect(unit.snapshot).toMatchObject({ saveLine: false, dirty: false });
  });

  it("is left alone by a Reset of the rest of its card", async () => {
    const server = fakeServer({ previewRows: 5000, queryTimeoutS: 90 });
    const unit = new SaveUnit({ title: "Queries", controls: [query, pinned], kept: { queryTimeoutS: 90, previewRows: 5000 }, write: server.write });
    unit.reset();
    expect(server.calls.map(call => call.patch)).toEqual([{ queryTimeoutS: null }]);
  });
});

describe("the leave guard", () => {
  function bound(guard: LeaveGuard, id: string, unit: SaveUnit) {
    const sync = () => guard.set(id, unit.snapshot.dirty ? { title: unit.title } : null);
    unit.subscribe(sync); sync();
  }

  it("asks only while typed text is unsaved, naming the cards", () => {
    const guard = new LeaveGuard();
    const instance = new SaveUnit({ title: "Instance", controls: [{ key: "instanceName", kind: "text" }], kept: { instanceName: "Atlas" }, write: fakeServer().write });
    const signInUnit = signIn(), account = new SaveUnit({ title: "Account", controls: [{ key: "name", kind: "text" }], kept: { name: "Ada" }, write: fakeServer().write });
    bound(guard, "instance", instance); bound(guard, "sign-in", signInUnit); bound(guard, "account", account);
    expect(guard.message()).toBeNull();
    signInUnit.edit("signInMessage", "Hello");
    expect(guard.message()).toEqual({
      title: "Discard unsaved changes?", body: ["Sign-in has changes that are not saved."], discard: "Discard changes", keep: "Keep editing",
    });
    instance.edit("instanceName", "Atlas North");
    expect(guard.message()?.body).toEqual(["Instance and Sign-in have changes that are not saved."]);
    account.edit("name", "Ada Lovelace");
    expect(guard.message()?.body).toEqual(["Instance, Sign-in and Account have changes that are not saved."]);
    signInUnit.cancel(); instance.edit("instanceName", "Atlas"); account.edit("name", "Ada");
    expect(guard.message()).toBeNull();
  });

  it("never asks for a value kept at once, answered or not", async () => {
    const guard = new LeaveGuard(), server = fakeServer(), unit = signIn(server, [query]);
    bound(guard, "sign-in", unit);
    unit.choose("landingPage", "maps");
    unit.step("queryTimeoutS", "61");
    expect(guard.message()).toBeNull();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(guard.message()).toBeNull();
  });

  it("asks while a new token secret is on screen, in its own words", () => {
    const guard = new LeaveGuard();
    guard.set("tokens-secret", { title: "API / MCP tokens", note: "The new token will not be shown again." });
    expect(guard.message()?.body).toEqual(["The new token will not be shown again."]);
    guard.set("tokens-secret", null);
    expect(guard.message()).toBeNull();
  });

  it("tells its listeners when what it holds changes", () => {
    const guard = new LeaveGuard(), heard = vi.fn();
    const stop = guard.subscribe(heard);
    guard.set("a", { title: "A" });
    guard.set("a", { title: "A" });
    guard.set("a", null);
    stop();
    guard.set("b", { title: "B" });
    expect(heard).toHaveBeenCalledTimes(2);
    expect(guard.holding()).toBe(true);
  });
});

describe("a card that checks its own text before Save", () => {
  const name: UnitControl = { key: "name", kind: "text" };
  const email: UnitControl = { key: "email", kind: "text" };
  function account(server = fakeServer({ name: "Ada", email: "ada@example.test" } as Record<string, Value>), refusalRows = false) {
    return new SaveUnit({
      title: "Account", controls: [name, email], write: server.write, refusalRows,
      kept: { name: "Ada", email: "ada@example.test" },
      validate: values => {
        const problems: Record<string, string> = {};
        if (!String(values.name ?? "").trim()) problems.name = "Enter a display name.";
        if (!String(values.email ?? "").trim()) problems.email = "Enter your email address.";
        return problems;
      },
    });
  }

  it("draws the red line under each field its check refuses, sends nothing, and focuses the first", () => {
    const server = fakeServer(), unit = account(server);
    unit.edit("name", " ");
    unit.edit("email", "");
    unit.save();
    expect(server.calls).toEqual([]);
    expect(unit.snapshot.errors).toEqual({ name: "Enter a display name.", email: "Enter your email address." });
    expect(unit.snapshot.busy).toBe(false);
    expect(unit.snapshot.saveLine).toBe(true);
    expect(unit.snapshot.focus).toMatchObject({ to: "field", key: "name" });
    unit.edit("name", "Ada Lovelace");
    expect(unit.snapshot.errors).toEqual({ email: "Enter your email address." });
  });

  it("can keep every refusal as the card's note, even one that uses a field's name as a word", async () => {
    const server = fakeServer(), unit = account(server);
    unit.edit("name", "Ada Lovelace");
    unit.save();
    server.calls[0].refuse("invalid_request", "Enter a name and email address."); await flush();
    expect(unit.snapshot.errors).toEqual({});
    expect(unit.snapshot.note).toEqual({ message: "Enter a name and email address.", retry: false });
    expect(unit.snapshot.saveLine).toBe(true);
  });
});
