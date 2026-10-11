import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultLook, LOOK_ATTRIBUTES, LOOK_KEYS, lookChoices, type Look, type LookKey } from "@/lib/look";
import { FADE_MS, UNDO_MS, WriteRefusal, type UnitSnapshot } from "./save-unit";
import { choiceLabel, LOOK_CARDS, LookReset, lookTab, LookWriter, lookUnit, PICTURE_PICKS, shownLook, stampLook, unitKey } from "./look-tab";

/**
 * The Appearance tab's own logic: its cards and rows, one writer every
 * look write goes through, what the page shows (each row's pick, or what
 * is kept for a row under a refusal), and the tab-wide Reset to Dezfil's
 * default with its Undo. The server is a fake the test answers by hand.
 */

function fakeServer(initial: Partial<Look> = {}) {
  let stored: Look = { ...defaultLook(), ...initial };
  const calls: { patch: Partial<Look>; accept: () => void; refuse: (message: string) => void; fail: () => void }[] = [];
  const send = vi.fn((patch: Partial<Look>) => new Promise<Look>((resolve, reject) => {
    calls.push({
      patch: { ...patch },
      accept: () => { stored = { ...stored, ...patch }; resolve({ ...stored }); },
      refuse: message => reject(new WriteRefusal("invalid_request", message, 400)),
      fail: () => reject(new Error("Dezfil could not reach the server.")),
    });
  }));
  return { send, calls, stored: () => stored };
}
const flush = () => vi.advanceTimersByTimeAsync(0);
const HARBOR: Look = { ...defaultLook(), color: "harbor", rail: "icons" };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("the cards and their rows", () => {
  it("are the four cards in order with the six picks and no other, Color first", () => {
    expect(LOOK_CARDS.map(card => [card.title, card.rows.map(row => row.label)])).toEqual([
      ["Color and contrast", ["Color", "Contrast"]],
      ["Background", ["Background"]],
      ["Text", ["Typeface"]],
      ["Layout", ["Corners", "Side menu"]],
    ]);
    // Every row is drawn as pictures; Panels is drawn before its row joins the tab.
    expect(LOOK_CARDS.flatMap(card => card.rows.map(row => row.key)).sort()).toEqual(PICTURE_PICKS.filter(key => key !== "panels").sort());
    expect([...PICTURE_PICKS]).toEqual(["color", "contrast", "font", "background", "corners", "rail", "panels"]);
    expect(new Set(LOOK_CARDS.flatMap(card => [card.id, ...card.rows.map(row => row.id)])).size).toBe(4 + 6);
  });

  it("name every choice in the product's words, and nothing the catalogue does not offer", () => {
    expect(lookChoices("background").map(value => choiceLabel("background", value))).toEqual(["Atlantic chart", "Plain", "Graticule", "Hex lattice"]);
    expect(lookChoices("rail").map(value => choiceLabel("rail", value))).toEqual(["Opens on hover", "Always open", "Icons only"]);
    expect(lookChoices("contrast").map(value => choiceLabel("contrast", value))).toEqual(["Standard", "More contrast"]);
    expect(lookChoices("panels").map(value => choiceLabel("panels", value))).toEqual(["Glass", "Liquid", "Paper"]);
    expect(lookChoices("liquidChrome").map(value => choiceLabel("liquidChrome", value))).toEqual(["On", "Off"]);
    expect(lookChoices("liquidDialogs").map(value => choiceLabel("liquidDialogs", value))).toEqual(["Off", "On"]);
    for (const key of LOOK_KEYS) for (const value of lookChoices(key)) expect(choiceLabel(key, value), `${key}=${value}`).toMatch(/^[A-Z][a-z ]+$/);
  });
});

describe("a card's writes", () => {
  it("send the card's picks as the look's slice, a reset as the defaults themselves, and report the card's rows", async () => {
    const server = fakeServer({ color: "slate", contrast: "more" });
    const writer = new LookWriter(server.send);
    const card = LOOK_CARDS[0];
    const unit = lookUnit(card, server.stored(), writer);
    unit.choose(unitKey("color"), "heather");
    expect(server.calls[0].patch).toEqual({ color: "heather" });
    server.calls[0].accept(); await flush();
    expect(unit.snapshot.kept).toEqual({ "look.color": "heather", "look.contrast": "more" });
    expect(unit.snapshot.saved).toEqual(["look.color"]);
    unit.reset();
    expect(server.calls[1].patch).toEqual({ color: "kelp", contrast: "standard" });
  });

  it("put a refusal naming a pick under its row, and keep nothing", async () => {
    const server = fakeServer();
    const unit = lookUnit(LOOK_CARDS[3], server.stored(), new LookWriter(server.send));
    unit.choose(unitKey("rail"), "open");
    server.calls[0].refuse("look.rail: Expected one of hover, open, icons."); await flush();
    expect(unit.snapshot.errors).toEqual({ "look.rail": "Expected one of hover, open, icons." });
    expect(unit.snapshot.saved).toEqual([]);
    expect(unit.snapshot.kept["look.rail"]).toBe("hover");
  });

  it("go one at a time through the tab's one writer, in the order they were made", async () => {
    const server = fakeServer();
    const writer = new LookWriter(server.send);
    const first = writer.write({ color: "harbor" }), second = writer.write({ corners: "soft" });
    expect(server.calls).toHaveLength(1);
    server.calls[0].accept(); await first;
    await flush();
    expect(server.calls).toHaveLength(2);
    server.calls[1].accept();
    expect(await second).toMatchObject({ color: "harbor", corners: "soft" });
    // A refused write lets the next one go.
    const third = writer.write({ font: "system" }), fourth = writer.write({ font: "inter" });
    server.calls[2].fail();
    await expect(third).rejects.toThrow();
    await flush();
    expect(server.calls).toHaveLength(4);
    server.calls[3].accept();
    await expect(fourth).resolves.toMatchObject({ font: "inter" });
  });
});

describe("what the page shows", () => {
  const snapshot = (values: Record<string, string>, kept: Record<string, string>, errors: Record<string, string> = {}) =>
    ({ values, kept, errors }) as unknown as UnitSnapshot;

  it("is each row's pick at once, or what is kept for a row under a refusal", () => {
    const shown = shownLook([
      snapshot({ "look.color": "harbor", "look.contrast": "more" }, { "look.color": "kelp", "look.contrast": "standard" }),
      snapshot({ "look.rail": "open", "look.corners": "soft" }, { "look.rail": "icons", "look.corners": "rounded" }, { "look.rail": "Refused." }),
    ]);
    expect(shown).toEqual({ ...defaultLook(), color: "harbor", contrast: "more", rail: "icons", corners: "soft" });
  });

  it("stamps the root with only the picks that differ, removing what no longer does", () => {
    const attributes = new Map<string, string>([["data-theme", "dark"], ["data-look-font", "system"]]);
    const touched = new Set<string>();
    const root = {
      setAttribute: (name: string, value: string) => { touched.add(name); attributes.set(name, value); },
      removeAttribute: (name: string) => { touched.add(name); attributes.delete(name); },
      getAttribute: (name: string) => attributes.get(name) ?? null,
    } as unknown as Element;
    stampLook(root, HARBOR);
    expect(Object.fromEntries(attributes)).toEqual({ "data-theme": "dark", "data-look-color": "harbor", "data-look-rail": "icons" });
    // Liquid: Panels, and the kinds that are on as one word list.
    stampLook(root, { ...HARBOR, panels: "liquid", liquidMenus: "on", liquidMap: "off" });
    expect(Object.fromEntries(attributes)).toEqual({ "data-theme": "dark", "data-look-color": "harbor", "data-look-rail": "icons",
      "data-look-panels": "liquid", "data-look-liquid": "chrome panels buttons menus" });
    // Paper keeps the kinds but stamps none of them.
    stampLook(root, { ...HARBOR, panels: "paper", liquidMenus: "on" });
    expect(Object.fromEntries(attributes)).toEqual({ "data-theme": "dark", "data-look-color": "harbor", "data-look-rail": "icons",
      "data-look-panels": "paper" });
    stampLook(root, defaultLook());
    expect(Object.fromEntries(attributes)).toEqual({ "data-theme": "dark" });
    // Only the look's own attributes are ever touched: never one per kind.
    expect([...touched].filter(name => !(LOOK_ATTRIBUTES as readonly string[]).includes(name))).toEqual([]);
  });
});

describe("Reset to Dezfil's default, and Undo", () => {
  function tab(initial: Partial<Look> = HARBOR) {
    const server = fakeServer(initial);
    const kept: Look[] = [];
    const reset = new LookReset({ write: new LookWriter(server.send).write, kept: look => { kept.push(look); } });
    return { server, kept, reset };
  }

  it("shows only while a pick differs from the default", () => {
    const { reset } = tab();
    expect(reset.slot(defaultLook())).toBeNull();
    for (const key of LOOK_KEYS) {
      const one = { ...defaultLook(), [key]: lookChoices(key as LookKey)[1] };
      expect(reset.slot(one), key).toBe("reset");
    }
  });

  it("returns every pick in one write, hands what was kept to the cards, then offers Undo with focus on it", async () => {
    const { server, kept, reset } = tab();
    reset.reset(HARBOR);
    expect(server.calls.map(call => call.patch)).toEqual([defaultLook()]);
    expect(reset.snapshot.busy).toBe(true);
    expect(reset.slot(HARBOR)).toBe("reset");
    server.calls[0].accept(); await flush();
    expect(kept).toEqual([defaultLook()]);
    expect(reset.slot(defaultLook())).toBe("undo");
    expect(reset.snapshot.focus?.to).toBe("undo");
  });

  it("writes the previous picks back in one write on Undo, then returns focus to the reset", async () => {
    const { server, kept, reset } = tab();
    reset.reset(HARBOR); server.calls[0].accept(); await flush();
    const seq = reset.snapshot.focus!.seq;
    reset.undo();
    expect(server.calls[1].patch).toEqual({ color: "harbor", rail: "icons" });
    expect(reset.slot(defaultLook())).toBe("undo");
    server.calls[1].accept(); await flush();
    expect(kept.at(-1)).toEqual(HARBOR);
    expect(reset.slot(HARBOR)).toBe("reset");
    expect(reset.snapshot.focus).toEqual({ to: "reset", seq: seq + 1 });
  });

  it("lets Undo go after six seconds, fading first", async () => {
    const { server, reset } = tab();
    reset.reset(HARBOR); server.calls[0].accept(); await flush();
    await vi.advanceTimersByTimeAsync(UNDO_MS - 1);
    expect(reset.slot(defaultLook())).toBe("undo");
    expect(reset.snapshot.leaving).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(reset.snapshot.leaving).toBe(true);
    await vi.advanceTimersByTimeAsync(FADE_MS);
    expect(reset.slot(defaultLook())).toBeNull();
  });

  it("holds Undo while focus or the pointer rests on it, and lets it go when both leave", async () => {
    const { server, reset } = tab();
    reset.reset(HARBOR); server.calls[0].accept(); await flush();
    reset.hold("focus", true);
    reset.hold("pointer", true);
    await vi.advanceTimersByTimeAsync(UNDO_MS * 3);
    expect(reset.slot(defaultLook())).toBe("undo");
    reset.hold("focus", false);
    await vi.advanceTimersByTimeAsync(FADE_MS * 2);
    expect(reset.slot(defaultLook())).toBe("undo");
    reset.hold("pointer", false);
    expect(reset.snapshot.leaving).toBe(true);
    await vi.advanceTimersByTimeAsync(FADE_MS);
    expect(reset.slot(defaultLook())).toBeNull();
  });

  it("lets Undo go at a newer pick, a card's reset or leaving the tab, and Undo then writes nothing", async () => {
    for (const leave of ["pick", "card", "tab"] as const) {
      const { server, reset } = tab();
      reset.reset(HARBOR); server.calls[0].accept(); await flush();
      if (leave === "tab") reset.leave(); else reset.drop();
      expect(reset.slot(defaultLook()), leave).toBeNull();
      reset.undo();
      expect(server.calls, leave).toHaveLength(1);
    }
  });

  it("carries on when the tab is mounted again after leaving, as a development remount does", async () => {
    const { server, reset } = tab();
    reset.leave();
    reset.reset(HARBOR); server.calls[0].accept(); await flush();
    expect(reset.slot(defaultLook())).toBe("undo");
  });

  it("offers no Undo when a newer pick came while the reset was on its way", async () => {
    const { server, reset } = tab();
    reset.reset(HARBOR);
    reset.drop();
    server.calls[0].accept(); await flush();
    expect(reset.slot(defaultLook())).toBeNull();
  });

  it("joins the cards' queue: a pick made before it and not yet sent never lands after it", async () => {
    const server = fakeServer(HARBOR);
    const { units, reset } = lookTab(server.stored(), server.send);
    const color = units[0];
    color.choose(unitKey("color"), "slate");
    color.choose(unitKey("color"), "heather");
    reset.reset(shownLook(units.map(unit => unit.snapshot)));
    server.calls[0].accept(); await flush();
    server.calls[1].accept(); await flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(server.calls.map(call => call.patch)).toEqual([{ color: "slate" }, defaultLook()]);
    expect(server.stored()).toEqual(defaultLook());
    expect(shownLook(units.map(unit => unit.snapshot))).toEqual(defaultLook());
    expect(reset.slot(defaultLook())).toBe("undo");
    reset.undo();
    expect(server.calls[2].patch).toEqual({ color: "heather", rail: "icons" });
  });

  it("shows a refused reset as the page's note with Try again, keeping every pick", async () => {
    const { server, kept, reset } = tab();
    reset.reset(HARBOR);
    server.calls[0].fail(); await flush();
    expect(kept).toEqual([]);
    expect(reset.snapshot.note).toEqual({ message: "Dezfil could not reach the server.", retry: true });
    expect(reset.slot(HARBOR)).toBe("reset");
    reset.retry(HARBOR);
    expect(server.calls[1].patch).toEqual(defaultLook());
    server.calls[1].accept(); await flush();
    expect(reset.snapshot.note).toBeNull();
    expect(reset.slot(defaultLook())).toBe("undo");
  });
});
