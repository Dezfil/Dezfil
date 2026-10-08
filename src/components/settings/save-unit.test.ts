import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FADE_MS, numberProblem, rowRefusals, SAVED_HOLD_MS, SaveUnit, SETTLE_MS, UNDO_MS, WriteRefusal, type UnitControl, type Value } from "./save-unit";
import { LeaveGuard } from "./leave-guard";

/**
 * The save unit's rules, against a fake server whose every answer the
 * test gives by hand: it accepts (storing what was sent, a null as the
 * default, and reporting every value back), refuses by code, fails like
 * a lost connection, or never answers.
 */

const DEFAULTS: Record<string, Value> = {
  landingPage: "home", signInMessage: "", lostPasswordContact: "", queryTimeoutS: 60, operationTimeoutS: 600, previewRows: 1000,
  "newLayer.lineWidth": 2, "newLayer.pointOpacity": 72, "sqlConsole.lineWrap": false,
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

  it("clears a row's Saved the moment its value changes again, and never shows it by a value the server then refuses", async () => {
    const server = fakeServer(), unit = signIn(server);
    unit.choose("landingPage", "maps");
    server.calls[0].accept(); await flush();
    expect(unit.snapshot.saved).toEqual(["landingPage"]);
    unit.choose("landingPage", "sql");
    expect(unit.snapshot.saved).toEqual([]);
    server.calls[1].refuse("invalid_request", "landingPage: Expected one of: home, maps."); await flush();
    expect(unit.snapshot.saved).toEqual([]);
    expect(unit.snapshot.errors.landingPage).toBe("Expected one of: home, maps.");
    // The mark's own timer is gone with it: nothing comes back when it would have run out.
    await vi.advanceTimersByTimeAsync(SAVED_HOLD_MS);
    expect(unit.snapshot.saved).toEqual([]);
  });

  it("clears a typed field's Saved when it is edited again", async () => {
    const server = fakeServer(), unit = signIn(server);
    unit.edit("signInMessage", "Hello");
    unit.save();
    server.calls[0].accept(); await flush();
    expect(unit.snapshot.saved).toEqual(["signInMessage"]);
    unit.edit("signInMessage", "Hello again");
    expect(unit.snapshot.saved).toEqual([]);
  });

  it("never marks a newer value Saved from an older write's answer", async () => {
    const server = fakeServer(), unit = limits(server);
    unit.edit("queryTimeoutS", "120"); unit.commit("queryTimeoutS");
    // Typed again while the first write is out, not yet committed.
    unit.edit("queryTimeoutS", "130");
    server.calls[0].accept(); await flush();
    expect(unit.snapshot.kept.queryTimeoutS).toBe(120);
    expect(unit.snapshot.values.queryTimeoutS).toBe("130");
    expect(unit.snapshot.saved).toEqual([]);
    // The same for typed text edited while its Save is out.
    const texts = fakeServer(), card = signIn(texts);
    card.edit("signInMessage", "Hello");
    card.save();
    card.edit("signInMessage", "Hello world");
    texts.calls[0].accept(); await flush();
    expect(card.snapshot.kept.signInMessage).toBe("Hello");
    expect(card.snapshot.values.signInMessage).toBe("Hello world");
    expect(card.snapshot.saved).toEqual([]);
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
    // Every control, the contact already at its default included.
    expect(server.calls.map(call => call.patch)).toEqual([{ signInMessage: null, lostPasswordContact: null, landingPage: null }]);
    server.calls[0].accept(); await flush();
    expect(unit.snapshot.kept).toMatchObject({ signInMessage: "", landingPage: "home" });
    expect(unit.snapshot.values).toMatchObject({ signInMessage: "", landingPage: "home" });
    expect(unit.snapshot.slot).toBe("undo");
    expect(unit.snapshot.saved).toEqual([]);
    expect(unit.snapshot.focus).toMatchObject({ to: "undo" });
  });

  it("puts back typed text in a field whose saved value is already its default, so the card holds nothing unsaved", async () => {
    const server = fakeServer({ landingPage: "maps" }), unit = signIn(server);
    unit.edit("signInMessage", "Typed, not saved");
    expect(unit.snapshot).toMatchObject({ dirty: true, slot: "reset" });
    unit.reset();
    expect(server.calls.map(call => call.patch)).toEqual([{ signInMessage: null, lostPasswordContact: null, landingPage: null }]);
    server.calls[0].accept(); await flush();
    expect(unit.snapshot.values).toEqual({ signInMessage: "", lostPasswordContact: "", landingPage: "home" });
    expect(unit.snapshot).toMatchObject({ dirty: false, saveLine: false, slot: "undo" });
    // Undo writes back what was saved, as before: the landing page alone differed.
    unit.undo();
    expect(server.calls[1].patch).toEqual({ landingPage: "maps" });
  });

  it("drops a stepped number still settling when Reset puts it back", async () => {
    const server = fakeServer({ queryTimeoutS: 90 }), unit = new SaveUnit({
      title: "Queries", controls: [query], write: server.write, kept: { queryTimeoutS: 90 },
    });
    unit.step("queryTimeoutS", "91");
    unit.reset();
    // The steps would settle while the Reset is still out.
    await vi.advanceTimersByTimeAsync(SETTLE_MS * 2);
    server.calls[0].accept(); await flush();
    await vi.advanceTimersByTimeAsync(SETTLE_MS * 2);
    expect(server.calls.map(call => call.patch)).toEqual([{ queryTimeoutS: null }]);
    expect(unit.snapshot.values.queryTimeoutS).toBe("60");
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

describe("a write made beside the card", () => {
  it("takes what another writer kept as a response is taken: the values, the defaults' Reset, no Saved, no Undo", async () => {
    const server = fakeServer({ landingPage: "maps" }), unit = signIn(server);
    unit.choose("landingPage", "sql");
    server.calls[0].accept(); await flush();
    expect(unit.snapshot.saved).toEqual(["landingPage"]);
    unit.sync({ landingPage: "home", unknownKey: "ignored" });
    expect(unit.snapshot.values.landingPage).toBe("home");
    expect(unit.snapshot.kept.landingPage).toBe("home");
    expect(unit.snapshot.saved).toEqual([]);
    expect(unit.snapshot.slot).toBeNull();
    expect(server.calls).toHaveLength(1);
  });

  it("lets the card's Undo go, since what it would write back is gone", async () => {
    const server = fakeServer({ landingPage: "maps" }), unit = signIn(server);
    unit.reset(); server.calls[0].accept(); await flush();
    expect(unit.snapshot.slot).toBe("undo");
    unit.sync({ landingPage: "projects" });
    expect(unit.snapshot.slot).toBe("reset");
    unit.undo();
    expect(server.calls).toHaveLength(1);
  });

  it("keeps a newer change on its way showing, and lands it when its own write answers", async () => {
    const server = fakeServer({ landingPage: "maps" }), unit = signIn(server);
    unit.choose("landingPage", "sql");
    unit.choose("landingPage", "data");
    unit.sync({ landingPage: "home" });
    expect(unit.snapshot.values.landingPage).toBe("data");
    expect(unit.snapshot.kept.landingPage).toBe("home");
    server.calls[0].accept(); await flush();
    server.calls[1].accept(); await flush();
    expect(unit.snapshot.values.landingPage).toBe("data");
    expect(unit.snapshot.saved).toEqual(["landingPage"]);
  });

  it("clears a row's red line with the value now kept", async () => {
    const server = fakeServer({ landingPage: "maps" }), unit = signIn(server);
    unit.choose("landingPage", "sql");
    server.calls[0].refuse("invalid_request", "landingPage: Not a page here."); await flush();
    expect(unit.snapshot.errors.landingPage).toBe("Not a page here.");
    unit.sync({ landingPage: "home" });
    expect(unit.snapshot.errors).toEqual({});
    expect(unit.snapshot.values.landingPage).toBe("home");
  });

  it("drops a change not yet sent when another writer's write goes past it, then shows what that write kept", async () => {
    const server = fakeServer({ landingPage: "maps" }), unit = signIn(server);
    unit.choose("landingPage", "sql");
    unit.choose("landingPage", "data");
    unit.supersede(["landingPage", "elsewhere"]);
    // The change on its way still shows until the other write answers.
    expect(unit.snapshot.values.landingPage).toBe("data");
    server.calls[0].accept(); await flush();
    expect(server.calls.map(call => call.patch)).toEqual([{ landingPage: "sql" }]);
    expect(unit.snapshot.saved).toEqual([]);
    expect(unit.snapshot.values.landingPage).toBe("data");
    unit.sync({ landingPage: "home" });
    expect(unit.snapshot.values.landingPage).toBe("home");
    expect(unit.snapshot.kept.landingPage).toBe("home");
    await vi.advanceTimersByTimeAsync(SAVED_HOLD_MS);
    expect(server.calls).toHaveLength(1);
  });

  it("returns a row the other write went past to what is kept when that write is refused", async () => {
    const server = fakeServer({ landingPage: "maps" }), unit = signIn(server);
    unit.choose("landingPage", "sql");
    unit.choose("landingPage", "data");
    unit.supersede(["landingPage"]);
    server.calls[0].accept(); await flush();
    unit.release(["landingPage"]);
    expect(unit.snapshot.values.landingPage).toBe("sql");
    expect(unit.snapshot.kept.landingPage).toBe("sql");
    expect(server.calls).toHaveLength(1);
  });

  it("sends a change made after the other write even when it repeats the write that write overtakes", async () => {
    const server = fakeServer({ landingPage: "maps" }), unit = signIn(server);
    unit.choose("landingPage", "sql");
    unit.choose("landingPage", "data");
    unit.supersede(["landingPage"]);
    // The other write lands after "sql", so "sql" again is a change of its own.
    unit.choose("landingPage", "sql");
    server.calls[0].accept(); await flush();
    expect(server.calls.map(call => call.patch)).toEqual([{ landingPage: "sql" }, { landingPage: "sql" }]);
    // The other write lands first and reports its value; the later change still shows.
    unit.sync({ landingPage: "home" });
    expect(unit.snapshot.values.landingPage).toBe("sql");
    server.calls[1].accept(); await flush();
    expect(unit.snapshot.values.landingPage).toBe("sql");
    expect(unit.snapshot.kept.landingPage).toBe("sql");
    expect(unit.snapshot.saved).toEqual(["landingPage"]);
    // Once the other write has answered, a repeat of what is on its way is not sent again.
    unit.choose("landingPage", "data");
    unit.choose("landingPage", "data");
    expect(server.calls.map(call => call.patch).slice(2)).toEqual([{ landingPage: "data" }]);
  });

  it("keeps a change made after the other write showing, and sends it after that write", async () => {
    const server = fakeServer({ landingPage: "maps" }), unit = signIn(server);
    unit.choose("landingPage", "sql");
    unit.supersede(["landingPage"]);
    unit.choose("landingPage", "data");
    unit.sync({ landingPage: "home" });
    expect(unit.snapshot.values.landingPage).toBe("data");
    server.calls[0].accept(); await flush();
    expect(server.calls.map(call => call.patch)).toEqual([{ landingPage: "sql" }, { landingPage: "data" }]);
    server.calls[1].accept(); await flush();
    expect(unit.snapshot.values.landingPage).toBe("data");
    expect(unit.snapshot.saved).toEqual(["landingPage"]);
  });
});

describe("a number with decimals, and a switch", () => {
  const width: UnitControl = { key: "newLayer.lineWidth", kind: "number", decimal: true, min: 0.5, max: 50, defaultValue: 2 };
  const opacity: UnitControl = { key: "newLayer.pointOpacity", kind: "number", min: 10, max: 100, defaultValue: 72 };
  const wrap: UnitControl = { key: "sqlConsole.lineWrap", kind: "switch", defaultValue: false };
  function card(server: ReturnType<typeof fakeServer>, controls: UnitControl[] = [width, opacity, wrap]) {
    return new SaveUnit({
      title: "New things", controls, write: server.write,
      kept: Object.fromEntries(controls.map(control => [control.key, server.stored[control.key]])),
    });
  }

  it("keeps a decimal at once when stepped, and on Enter or leaving when typed, as given and never rounded", async () => {
    const server = fakeServer(), unit = card(server);
    unit.step("newLayer.lineWidth", "2.5");
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(server.calls.map(call => call.patch)).toEqual([{ "newLayer.lineWidth": 2.5 }]);
    expect(unit.snapshot.saved).toEqual([]);
    server.calls[0].accept(); await flush();
    expect(unit.snapshot.kept["newLayer.lineWidth"]).toBe(2.5);
    expect(unit.snapshot.values["newLayer.lineWidth"]).toBe("2.5");
    expect(unit.snapshot.saved).toEqual(["newLayer.lineWidth"]);
    unit.edit("newLayer.lineWidth", "0.75");
    expect(server.calls).toHaveLength(1);
    unit.commit("newLayer.lineWidth");
    expect(server.calls[1].patch).toEqual({ "newLayer.lineWidth": 0.75 });
    expect(unit.snapshot.saveLine).toBe(false);
  });

  it("accepts a decimal only for a number that takes one, and refuses the rest before any request", async () => {
    const server = fakeServer(), unit = card(server);
    for (const [key, typed, words] of [
      ["newLayer.pointOpacity", "72.5", "Enter a whole number."],
      ["newLayer.lineWidth", "0.4", "Enter a number from 0.5 to 50."],
      ["newLayer.lineWidth", "50.25", "Enter a number from 0.5 to 50."],
      ["newLayer.lineWidth", "", "Enter a number."],
    ]) {
      unit.edit(key, typed); unit.commit(key);
      expect(unit.snapshot.errors[key]).toBe(words);
    }
    unit.step("newLayer.pointOpacity", "73.5");
    await vi.advanceTimersByTimeAsync(SETTLE_MS * 2);
    expect(unit.snapshot.errors["newLayer.pointOpacity"]).toBe("Enter a whole number.");
    expect(server.calls).toHaveLength(0);
    expect(numberProblem("1.3", { min: 0, max: 22, decimal: true })).toBeNull();
    expect(numberProblem("-85", { min: -85, max: 85, decimal: true })).toBeNull();
    expect(numberProblem("85.01", { min: -85, max: 85, decimal: true })).toBe("Enter a number from -85 to 85.");
    expect(numberProblem("1.3", { min: 0, max: 22 })).toBe("Enter a whole number.");
  });

  it("keeps a switch at once, as a choice is, its value true or false, and shows Saved only on the write's response", async () => {
    const server = fakeServer(), unit = card(server, [wrap]);
    expect(unit.snapshot.values["sqlConsole.lineWrap"]).toBe(false);
    unit.choose("sqlConsole.lineWrap", true);
    expect(server.calls.map(call => call.patch)).toEqual([{ "sqlConsole.lineWrap": true }]);
    expect(unit.snapshot.values["sqlConsole.lineWrap"]).toBe(true);
    expect(unit.snapshot).toMatchObject({ saved: [], saveLine: false, dirty: false });
    server.calls[0].accept(); await flush();
    expect(unit.snapshot.kept["sqlConsole.lineWrap"]).toBe(true);
    expect(unit.snapshot.values["sqlConsole.lineWrap"]).toBe(true);
    expect(unit.snapshot.saved).toEqual(["sqlConsole.lineWrap"]);
    // Off again is a change of its own; on, while on is kept, is none.
    unit.choose("sqlConsole.lineWrap", true);
    expect(server.calls).toHaveLength(1);
    unit.choose("sqlConsole.lineWrap", false);
    expect(server.calls[1].patch).toEqual({ "sqlConsole.lineWrap": false });
  });

  it("never shows Saved for a decimal or a switch the server refuses, and keeps nothing", async () => {
    const server = fakeServer(), unit = card(server);
    unit.edit("newLayer.lineWidth", "2.5"); unit.commit("newLayer.lineWidth");
    expect(server.calls.map(call => call.patch)).toEqual([{ "newLayer.lineWidth": 2.5 }]);
    server.calls[0].refuse("invalid_request", "newLayer.lineWidth: Expected a number from 0.5 to 50."); await flush();
    expect(unit.snapshot.errors).toEqual({ "newLayer.lineWidth": "Expected a number from 0.5 to 50." });
    expect(unit.snapshot.kept["newLayer.lineWidth"]).toBe(2);
    unit.choose("sqlConsole.lineWrap", true);
    server.calls[1].refuse("forbidden", "Only admins can change instance settings.", 403); await flush();
    await vi.advanceTimersByTimeAsync(SAVED_HOLD_MS * 2);
    expect(unit.snapshot.saved).toEqual([]);
    expect(unit.snapshot.kept["sqlConsole.lineWrap"]).toBe(false);
    expect(unit.snapshot.values["sqlConsole.lineWrap"]).toBe(false);
    expect(unit.snapshot.note).toEqual({ message: "Only admins can change instance settings.", retry: false });
    expect(server.stored).toMatchObject({ "newLayer.lineWidth": 2, "sqlConsole.lineWrap": false });
  });

  it("returns a decimal and a switch to their defaults with the rest of the card, and Undo writes them back", async () => {
    const server = fakeServer({ "newLayer.lineWidth": 2.5, "sqlConsole.lineWrap": true }), unit = card(server);
    expect(unit.snapshot.slot).toBe("reset");
    unit.reset();
    expect(server.calls.map(call => call.patch)).toEqual([{ "newLayer.lineWidth": null, "newLayer.pointOpacity": null, "sqlConsole.lineWrap": null }]);
    server.calls[0].accept(); await flush();
    expect(unit.snapshot.values).toEqual({ "newLayer.lineWidth": "2", "newLayer.pointOpacity": "72", "sqlConsole.lineWrap": false });
    expect(unit.snapshot.slot).toBe("undo");
    unit.undo();
    expect(server.calls[1].patch).toEqual({ "newLayer.lineWidth": 2.5, "sqlConsole.lineWrap": true });
    server.calls[1].accept(); await flush();
    expect(unit.snapshot.values).toEqual({ "newLayer.lineWidth": "2.5", "newLayer.pointOpacity": "72", "sqlConsole.lineWrap": true });
  });
});

describe("numbers set together", () => {
  const latitude: UnitControl = { key: "newMap.latitude", kind: "number", decimal: true, min: -85, max: 85, defaultValue: 40 };
  const longitude: UnitControl = { key: "newMap.longitude", kind: "number", decimal: true, min: -180, max: 180, defaultValue: 0 };
  const zoom: UnitControl = { key: "newMap.zoom", kind: "number", decimal: true, min: 0, max: 22, defaultValue: 1.3 };
  function view(server = fakeServer({ "newMap.latitude": 40, "newMap.longitude": 0, "newMap.zoom": 1.3 })) {
    const unit = new SaveUnit({
      title: "New maps", controls: [latitude, longitude, zoom], write: server.write,
      kept: { "newMap.latitude": 40, "newMap.longitude": 0, "newMap.zoom": 1.3 },
    });
    return { server, unit };
  }

  it("keeps every changed number in one write, each field showing its text, and marks each Saved on the response", async () => {
    const { server, unit } = view();
    unit.keepTogether({ "newMap.latitude": "50.11", "newMap.longitude": "8.68", "newMap.zoom": "1.3" });
    expect(server.calls.map(call => call.patch)).toEqual([{ "newMap.latitude": 50.11, "newMap.longitude": 8.68 }]);
    expect(unit.snapshot.values).toMatchObject({ "newMap.latitude": "50.11", "newMap.longitude": "8.68" });
    server.calls[0].accept(); await flush();
    expect(unit.snapshot.kept).toMatchObject({ "newMap.latitude": 50.11, "newMap.longitude": 8.68, "newMap.zoom": 1.3 });
    expect([...unit.snapshot.saved].sort()).toEqual(["newMap.latitude", "newMap.longitude"]);
  });

  it("drops a number still settling from its steps, so it never lands after the numbers set together", async () => {
    const { server, unit } = view();
    unit.step("newMap.latitude", "41");
    unit.keepTogether({ "newMap.latitude": "-33.87", "newMap.longitude": "151.21" });
    await vi.advanceTimersByTimeAsync(SETTLE_MS * 2);
    expect(server.calls.map(call => call.patch)).toEqual([{ "newMap.latitude": -33.87, "newMap.longitude": 151.21 }]);
  });

  it("waits behind a write on its way, and still sends both numbers in one write", async () => {
    const { server, unit } = view();
    unit.edit("newMap.zoom", "4"); unit.commit("newMap.zoom");
    unit.keepTogether({ "newMap.latitude": "10", "newMap.longitude": "20" });
    expect(server.calls).toHaveLength(1);
    server.calls[0].accept(); await flush();
    expect(server.calls.map(call => call.patch)).toEqual([{ "newMap.zoom": 4 }, { "newMap.latitude": 10, "newMap.longitude": 20 }]);
  });

  it("draws the red line under a number its check refuses and keeps the others", () => {
    const { server, unit } = view();
    unit.keepTogether({ "newMap.latitude": "90", "newMap.longitude": "8.5" });
    expect(unit.snapshot.errors).toEqual({ "newMap.latitude": "Enter a number from -85 to 85." });
    expect(server.calls.map(call => call.patch)).toEqual([{ "newMap.longitude": 8.5 }]);
  });

  it("sends nothing when every number is already what is kept, and ignores a key the card does not hold", () => {
    const { server, unit } = view();
    unit.keepTogether({ "newMap.latitude": "40", "newMap.longitude": "0", "newMap.pitch": "30" });
    expect(server.calls).toHaveLength(0);
    expect(unit.snapshot.values).not.toHaveProperty("newMap.pitch");
  });
});

describe("a row of several numbers sharing one Saved", () => {
  const row = "set-starting-view";
  const latitude: UnitControl = { key: "newMap.latitude", kind: "number", decimal: true, min: -85, max: 85, defaultValue: 40, row };
  const longitude: UnitControl = { key: "newMap.longitude", kind: "number", decimal: true, min: -180, max: 180, defaultValue: 0, row };
  const zoom: UnitControl = { key: "newMap.zoom", kind: "number", decimal: true, min: 0, max: 22, defaultValue: 1.3, row };
  const kept = { "newMap.latitude": 40, "newMap.longitude": 0, "newMap.zoom": 1.3 };
  function view() {
    const server = fakeServer(kept);
    return { server, unit: new SaveUnit({ title: "New maps", controls: [latitude, longitude, zoom], write: server.write, kept }) };
  }
  async function latitudeKept() {
    const { server, unit } = view();
    unit.edit("newMap.latitude", "51.5074"); unit.commit("newMap.latitude");
    server.calls[0].accept(); await flush();
    expect(unit.snapshot.saved).toEqual(["newMap.latitude"]);
    // Still within the latitude's hold.
    await vi.advanceTimersByTimeAsync(SAVED_HOLD_MS / 2);
    return { server, unit };
  }

  it("clears the row's Saved and its timer at an edit in any of its fields, and shows none beside a red line", async () => {
    const { server, unit } = await latitudeKept();
    unit.edit("newMap.zoom", "30");
    expect(unit.snapshot.saved).toEqual([]);
    unit.commit("newMap.zoom");
    expect(unit.snapshot.errors).toEqual({ "newMap.zoom": "Enter a number from 0 to 22." });
    expect(unit.snapshot.saved).toEqual([]);
    await vi.advanceTimersByTimeAsync(SAVED_HOLD_MS * 2);
    expect(unit.snapshot.saved).toEqual([]);
    expect(server.calls).toHaveLength(1);
  });

  it("clears it at a step in another of its fields too", async () => {
    const { unit } = await latitudeKept();
    unit.step("newMap.longitude", "9");
    expect(unit.snapshot.saved).toEqual([]);
  });

  it("shows no Saved for a write the row's other field still refuses, and shows it again once the row's next write is accepted with none refused", async () => {
    const { server, unit } = view();
    unit.edit("newMap.zoom", "30"); unit.commit("newMap.zoom");
    unit.keepTogether({ "newMap.latitude": "51.5", "newMap.longitude": "90" });
    server.calls[0].accept(); await flush();
    expect(unit.snapshot.kept).toMatchObject({ "newMap.latitude": 51.5, "newMap.longitude": 90 });
    expect(unit.snapshot.errors).toEqual({ "newMap.zoom": "Enter a number from 0 to 22." });
    expect(unit.snapshot.saved).toEqual([]);
    unit.edit("newMap.zoom", "3"); unit.commit("newMap.zoom");
    server.calls[1].accept(); await flush();
    expect(unit.snapshot.errors).toEqual({});
    expect(unit.snapshot.saved).toEqual(["newMap.zoom"]);
  });

  it("shows no Saved while another of its fields still has a change on its way, or typed and not yet kept", async () => {
    const { server, unit } = view();
    unit.edit("newMap.latitude", "10"); unit.commit("newMap.latitude");
    unit.edit("newMap.longitude", "20"); unit.commit("newMap.longitude");
    server.calls[0].accept(); await flush();
    expect(unit.snapshot.saved).toEqual([]);
    unit.edit("newMap.zoom", "4");
    server.calls[1].accept(); await flush();
    expect(unit.snapshot.saved).toEqual([]);
    unit.commit("newMap.zoom");
    server.calls[2].accept(); await flush();
    expect(unit.snapshot.saved).toEqual(["newMap.zoom"]);
  });

  it("leaves a number in a row of its own as it was: its Saved holds while another field of the card is edited", async () => {
    const server = fakeServer(), unit = limits(server);
    unit.edit("queryTimeoutS", "90"); unit.commit("queryTimeoutS");
    server.calls[0].accept(); await flush();
    unit.edit("operationTimeoutS", "700");
    expect(unit.snapshot.saved).toEqual(["queryTimeoutS"]);
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

describe("a choice that waits for the card's Save", () => {
  // Listed sites chosen while no site is listed: the choice cannot be kept
  // alone, so it waits for the sites and goes with them in one write.
  const embedding: UnitControl = { key: "embedding", kind: "choice", defaultValue: "any" };
  const sites: UnitControl = { key: "sites", kind: "text" };
  const NONE_LISTED = "Add at least one site, or choose Any site.";
  function links(server = fakeServer({ embedding: "any", sites: "" } as Record<string, Value>)) {
    return new SaveUnit({
      title: "Public links", controls: [embedding, sites], write: server.write,
      kept: { embedding: server.stored.embedding, sites: server.stored.sites },
      validate: values => values.embedding === "listed" && !String(values.sites ?? "").trim() ? { sites: NONE_LISTED } : null,
    });
  }

  it("shows the held choice and sends nothing, with Save and Cancel offered and the leave guard told", () => {
    const server = fakeServer({ embedding: "any", sites: "" } as Record<string, Value>), unit = links(server);
    unit.hold("embedding", "listed");
    expect(server.calls).toEqual([]);
    expect(unit.snapshot.values.embedding).toBe("listed");
    expect(unit.snapshot.kept.embedding).toBe("any");
    expect(unit.snapshot.saveLine).toBe(true);
    expect(unit.snapshot.dirty).toBe(true);
  });

  it("goes with the typed text in one write on Save, Saved by both only on the response", async () => {
    const server = fakeServer({ embedding: "any", sites: "" } as Record<string, Value>), unit = links(server);
    unit.hold("embedding", "listed");
    unit.edit("sites", "https://a.example");
    unit.save();
    expect(server.calls.map(call => call.patch)).toEqual([{ embedding: "listed", sites: "https://a.example" }]);
    expect(unit.snapshot.saved).toEqual([]);
    server.calls[0].accept(); await flush();
    expect(unit.snapshot.kept).toEqual({ embedding: "listed", sites: "https://a.example" });
    expect([...unit.snapshot.saved].sort()).toEqual(["embedding", "sites"]);
    expect(unit.snapshot.saveLine).toBe(false);
    expect(unit.snapshot.dirty).toBe(false);
  });

  it("is checked with the text before any request, and stays waiting", () => {
    const server = fakeServer({ embedding: "any", sites: "" } as Record<string, Value>), unit = links(server);
    unit.hold("embedding", "listed");
    unit.save();
    expect(server.calls).toEqual([]);
    expect(unit.snapshot.errors).toEqual({ sites: NONE_LISTED });
    expect(unit.snapshot.values.embedding).toBe("listed");
    expect(unit.snapshot.saveLine).toBe(true);
  });

  it("stays waiting when the Save is refused", async () => {
    const server = fakeServer({ embedding: "any", sites: "" } as Record<string, Value>), unit = links(server);
    unit.hold("embedding", "listed");
    unit.edit("sites", "ftp://a.example");
    unit.save();
    server.calls[0].refuse("invalid_request", "sites: Expected each site as http or https; entry 1 is not."); await flush();
    expect(unit.snapshot.errors).toEqual({ sites: "Expected each site as http or https; entry 1 is not." });
    expect(unit.snapshot.values.embedding).toBe("listed");
    expect(unit.snapshot.kept.embedding).toBe("any");
    expect(unit.snapshot.saveLine).toBe(true);
    unit.edit("sites", "https://a.example");
    unit.save();
    expect(server.calls[1].patch).toEqual({ embedding: "listed", sites: "https://a.example" });
  });

  it("goes back to what is kept on Cancel, and Save then sends nothing", () => {
    const server = fakeServer({ embedding: "any", sites: "" } as Record<string, Value>), unit = links(server);
    unit.hold("embedding", "listed");
    unit.cancel();
    expect(unit.snapshot.values.embedding).toBe("any");
    expect(unit.snapshot.saveLine).toBe(false);
    unit.save();
    expect(server.calls).toEqual([]);
  });

  it("lets go when the person chooses again: the new choice is kept at once and the wait ends", () => {
    const server = fakeServer({ embedding: "any", sites: "" } as Record<string, Value>), unit = links(server);
    unit.hold("embedding", "listed");
    unit.choose("embedding", "off");
    expect(server.calls.map(call => call.patch)).toEqual([{ embedding: "off" }]);
    expect(unit.snapshot.saveLine).toBe(false);
    unit.hold("embedding", "listed");
    unit.choose("embedding", "off");
    // Back on what the write on its way ends at: nothing more is sent.
    expect(server.calls).toHaveLength(1);
    expect(unit.snapshot.saveLine).toBe(false);
  });

  it("holds nothing but a choice", () => {
    const server = fakeServer({ embedding: "any", sites: "" } as Record<string, Value>), unit = links(server);
    unit.hold("sites", "https://a.example");
    expect(unit.snapshot.values.sites).toBe("");
    expect(unit.snapshot.saveLine).toBe(false);
  });
});
