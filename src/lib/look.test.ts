import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { open } from "@/lib/metadata/db";
import { insertAccount } from "@/lib/metadata/accounts";
import { accountLook } from "@/lib/metadata/account-preferences";
import { defaultLook, LOOK_ATTRIBUTES, LOOK_KEYS, lookAttributes, lookChoices, normalizeLook } from "./look";

/** Today's look, written out rather than derived, so the module's own
 * reading of the catalogue cannot stand on both sides of a comparison:
 * the six picks, Panels on Glass and Transparency at Clear. */
const TODAY = {
  color: "kelp", contrast: "standard", font: "inter", background: "atlantic", corners: "rounded", rail: "hover", panels: "glass",
  transparency: "clear",
};
/** The kinds of surface an earlier version let Liquid reach one by one,
 * which an account may still keep. */
const RETIRED_KINDS = ["liquidChrome", "liquidPanels", "liquidMap", "liquidButtons", "liquidCards", "liquidInner", "liquidMenus", "liquidDialogs"];
const EVERY_KIND = Object.fromEntries(RETIRED_KINDS.map(key => [key, "on"]));
const NO_KIND = Object.fromEntries(RETIRED_KINDS.map(key => [key, "off"]));

describe("the look's picks and Dezfil's default", () => {
  it("names the eight picks, each offering the catalogue's choices with today's value first", () => {
    expect([...LOOK_KEYS]).toEqual(["color", "contrast", "font", "background", "corners", "rail", "panels", "transparency"]);
    expect(defaultLook()).toEqual(TODAY);
    for (const key of LOOK_KEYS) expect(lookChoices(key)[0]).toBe(TODAY[key]);
    expect(lookChoices("background")).toEqual(["atlantic", "plain", "graticule", "hex"]);
    expect(lookChoices("panels")).toEqual(["glass", "liquid", "paper"]);
    expect(lookChoices("transparency")).toEqual(["clear", "medium", "firm"]);
  });
});

describe("reading a stored look", () => {
  it.each([["nothing", undefined], ["null", null], ["a bare value", "harbor"], ["a list", ["harbor"]], ["a number", 7]])(
    "reads %s as Dezfil's default look", (_label, stored) => {
      expect(normalizeLook(stored)).toEqual(TODAY);
    });

  it("keeps every pick the version offers and fills the missing ones with their defaults", () => {
    expect(normalizeLook({ color: "harbor", rail: "icons" })).toEqual({ ...TODAY, color: "harbor", rail: "icons" });
    const every = { color: "slate", contrast: "more", font: "system", background: "hex", corners: "soft", rail: "open", panels: "paper",
      transparency: "firm" };
    expect(normalizeLook(every)).toEqual(every);
  });

  it("reads a value the version does not offer, or one of the wrong kind, as that pick's default", () => {
    expect(normalizeLook({ color: "teal", contrast: "MORE", font: 1, background: "contours", corners: ["soft"], rail: "", transparency: "opaque" }))
      .toEqual(TODAY);
    expect(normalizeLook({ color: "heather", background: "soundings" })).toEqual({ ...TODAY, color: "heather" });
    // A retired look.
    expect(normalizeLook({ panels: "frosted" })).toEqual(TODAY);
  });

  it("drops picks this version does not have and never reads an inherited value", () => {
    const read = normalizeLook({ color: "slate", density: "compact", glow: "on", liquidAll: "on" });
    expect(read).toEqual({ ...TODAY, color: "slate" });
    // The kinds an earlier version kept, every one of them on or off, are no pick of this one.
    expect(normalizeLook({ panels: "liquid", ...NO_KIND })).toEqual({ ...TODAY, panels: "liquid" });
    expect(normalizeLook({ panels: "liquid", ...EVERY_KIND })).toEqual({ ...TODAY, panels: "liquid" });
    expect(Object.keys(read).sort()).toEqual([...LOOK_KEYS].sort());
    expect(normalizeLook(Object.create({ color: "harbor" }))).toEqual(TODAY);
  });
});

describe("the root's attributes", () => {
  it("carry nothing for Dezfil's default look", () => {
    expect(lookAttributes(TODAY)).toEqual({});
    expect(lookAttributes({})).toEqual({});
  });

  it("carry only the picks that differ from the default, one data-look attribute each", () => {
    expect(lookAttributes({ ...TODAY, color: "harbor" })).toEqual({ "data-look-color": "harbor" });
    expect(lookAttributes({ ...TODAY, color: "kelp", corners: "soft" })).toEqual({ "data-look-corners": "soft" });
    expect(lookAttributes({ color: "slate", contrast: "more", font: "system", background: "plain", corners: "soft", rail: "icons" })).toEqual({
      "data-look-color": "slate", "data-look-contrast": "more", "data-look-font": "system",
      "data-look-background": "plain", "data-look-corners": "soft", "data-look-rail": "icons",
    });
  });

  it("never carry a value the version does not offer", () => {
    expect(lookAttributes({ ...TODAY, color: "teal\" onload=\"x", rail: "open" })).toEqual({ "data-look-rail": "open" });
    expect(lookAttributes({ ...TODAY, panels: "frosted" })).toEqual({});
  });

  it("name Panels when it is not Glass, Liquid by its pick alone whatever kinds an account still keeps", () => {
    expect(lookAttributes({ ...TODAY, panels: "liquid" })).toEqual({ "data-look-panels": "liquid" });
    expect(lookAttributes({ ...TODAY, panels: "liquid", ...NO_KIND } as Record<string, unknown>)).toEqual({ "data-look-panels": "liquid" });
    expect(lookAttributes({ ...TODAY, panels: "liquid", ...EVERY_KIND } as Record<string, unknown>)).toEqual({ "data-look-panels": "liquid" });
    expect(lookAttributes({ ...TODAY, panels: "paper", ...EVERY_KIND } as Record<string, unknown>)).toEqual({ "data-look-panels": "paper" });
    expect(lookAttributes({ ...TODAY, ...EVERY_KIND } as Record<string, unknown>)).toEqual({});
  });

  it("name Transparency when it is not Clear, whatever Panels is: Liquid's sheet alone reads it", () => {
    expect(lookAttributes({ ...TODAY, panels: "liquid", transparency: "firm" }))
      .toEqual({ "data-look-panels": "liquid", "data-look-transparency": "firm" });
    expect(lookAttributes({ ...TODAY, transparency: "medium" })).toEqual({ "data-look-transparency": "medium" });
    expect(lookAttributes({ ...TODAY, panels: "liquid", transparency: "clear" })).toEqual({ "data-look-panels": "liquid" });
    expect(lookAttributes({ ...TODAY, panels: "liquid", transparency: "opaque" })).toEqual({ "data-look-panels": "liquid" });
  });

  it("are drawn from one fixed list, one attribute per pick", () => {
    expect([...LOOK_ATTRIBUTES]).toEqual(["data-look-color", "data-look-contrast", "data-look-font", "data-look-background",
      "data-look-corners", "data-look-rail", "data-look-panels", "data-look-transparency"]);
    const every = lookAttributes({ color: "slate", contrast: "more", font: "system", background: "hex", corners: "soft", rail: "open",
      panels: "liquid", transparency: "medium" });
    expect(Object.keys(every)).toEqual([...LOOK_ATTRIBUTES]);
  });
});

describe("one account's look from its preferences", () => {
  let db: Database;
  const now = new Date().toISOString();
  const preferences = (id: string) =>
    (db.prepare("SELECT view_prefs, updated_at FROM account_preferences WHERE account_id = ?").get(id) as { view_prefs: string; updated_at: string } | undefined);
  const keep = (id: string, document: unknown) =>
    db.prepare("INSERT INTO account_preferences (account_id, view_prefs, updated_at) VALUES (?, ?, ?)").run(id, JSON.stringify(document), "kept");
  beforeEach(() => {
    db = open(":memory:");
    for (const id of ["ada", "bea"]) insertAccount({ id, name: id, email: `${id}@example.test`, passwordHash: null, isAdmin: false, status: "active", now }, db);
  });
  afterEach(() => db.close());

  it("reads the default look for an account that never picked, with or without other preferences", () => {
    expect(accountLook("ada", db)).toEqual(TODAY);
    expect(preferences("ada")).toBeUndefined();
    keep("bea", { maps: { view: "list" }, sourceGrouping: "project" });
    expect(accountLook("bea", db)).toEqual(TODAY);
  });

  it("reads the kept picks, a retired value as its default, a retired kind as nothing, and writes nothing back", () => {
    keep("ada", { maps: { view: "list" }, look: { color: "heather", background: "contours", rail: "open", ...NO_KIND } });
    const before = preferences("ada");
    expect(accountLook("ada", db)).toEqual({ ...TODAY, color: "heather", rail: "open" });
    expect(preferences("ada")).toEqual(before);
  });

  it("reads only the account it is asked for", () => {
    keep("bea", { look: { color: "slate", corners: "soft" } });
    expect(accountLook("ada", db)).toEqual(TODAY);
    expect(accountLook("bea", db)).toEqual({ ...TODAY, color: "slate", corners: "soft" });
  });
});
