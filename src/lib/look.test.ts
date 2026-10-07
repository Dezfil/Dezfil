import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { open } from "@/lib/metadata/db";
import { insertAccount } from "@/lib/metadata/accounts";
import { accountLook } from "@/lib/metadata/account-preferences";
import { defaultLook, LOOK_KEYS, lookAttributes, lookChoices, normalizeLook } from "./look";

/** Today's look, written out rather than derived, so the module's own
 * reading of the catalogue cannot stand on both sides of a comparison. */
const TODAY = { color: "kelp", contrast: "standard", font: "inter", background: "atlantic", corners: "rounded", rail: "hover" };

describe("the look's picks and Dezfil's default", () => {
  it("names the six picks, each offering the catalogue's choices with today's value first", () => {
    expect([...LOOK_KEYS]).toEqual(["color", "contrast", "font", "background", "corners", "rail"]);
    expect(defaultLook()).toEqual(TODAY);
    for (const key of LOOK_KEYS) expect(lookChoices(key)[0]).toBe(TODAY[key]);
    expect(lookChoices("background")).toEqual(["atlantic", "plain", "graticule", "hex"]);
  });
});

describe("reading a stored look", () => {
  it.each([["nothing", undefined], ["null", null], ["a bare value", "harbor"], ["a list", ["harbor"]], ["a number", 7]])(
    "reads %s as Dezfil's default look", (_label, stored) => {
      expect(normalizeLook(stored)).toEqual(TODAY);
    });

  it("keeps every pick the version offers and fills the missing ones with their defaults", () => {
    expect(normalizeLook({ color: "harbor", rail: "icons" })).toEqual({ ...TODAY, color: "harbor", rail: "icons" });
    const every = { color: "slate", contrast: "more", font: "system", background: "hex", corners: "soft", rail: "open" };
    expect(normalizeLook(every)).toEqual(every);
  });

  it("reads a value the version does not offer, or one of the wrong kind, as that pick's default", () => {
    expect(normalizeLook({ color: "teal", contrast: "MORE", font: 1, background: "contours", corners: ["soft"], rail: "" }))
      .toEqual(TODAY);
    expect(normalizeLook({ color: "heather", background: "soundings" })).toEqual({ ...TODAY, color: "heather" });
  });

  it("drops picks this version does not have and never reads an inherited value", () => {
    const read = normalizeLook({ color: "slate", density: "compact", panels: "liquid" });
    expect(read).toEqual({ ...TODAY, color: "slate" });
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

  it("reads the kept picks, a retired value as its default, and writes nothing back", () => {
    keep("ada", { maps: { view: "list" }, look: { color: "heather", background: "contours", rail: "open" } });
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
