import { describe, expect, it } from "vitest";
import type { Account } from "@/lib/metadata/accounts";
import { defaultLook } from "@/lib/look";
import { instanceReadFixture } from "./read-fixture";
import { settingsDeclarations, withLiveValues, type IndexSources } from "./settings-index";
import { buildSearchIndex, hitPath, searchSettings, type IndexCard, type SearchHit } from "./settings-search";

/**
 * The Settings search: an index over every tab, card and row the person
 * may see, by the label they see, keywords and the words of the current
 * value, plus two pointers to controls outside the page; and the order
 * its results come in.
 */

const ACCOUNT = { id: "ada", name: "Ada Okafor", email: "ada@example.test", sqlName: "ada_okafor", isAdmin: true } as Account;
const TOKENS = [
  { id: "t1", name: "Laptop CLI", createdAt: "2026-10-01T00:00:00.000Z", lastUsedAt: null, revokedAt: null },
  { id: "t2", name: "Old script", createdAt: "2026-09-01T00:00:00.000Z", lastUsedAt: null, revokedAt: "2026-09-20T00:00:00.000Z" },
];

function sources(overrides: Partial<IndexSources> = {}): IndexSources {
  return {
    account: ACCOUNT, tokens: TOKENS, look: { ...defaultLook(), color: "heather", rail: "icons" },
    instance: instanceReadFixture({
      instanceName: { value: "Atlas North", source: "stored", storedValue: "Atlas North" },
      landingPage: { value: "maps", source: "stored", storedValue: "maps" },
      signInMessage: { value: "Use your work email.", source: "stored", storedValue: "Use your work email." },
      dataDir: { value: "/srv/dezfil", source: "environment", locked: true },
      geocoderUrl: { value: { set: true, origin: "https://geocoder.example" }, source: "environment", locked: true },
    }),
    entry: { instanceName: "Atlas North", signInMessage: "", lostPasswordContact: "the GIS team", landingPage: "projects" },
    health: "ready", assistant: { enabled: false, reason: "No model credential is configured." },
    ...overrides,
  };
}
const index = (admin = true, overrides: Partial<IndexSources> = {}) => buildSearchIndex(settingsDeclarations(sources(overrides), admin), admin);
const paths = (hits: SearchHit[]) => hits.map(hitPath);

describe("Appearance in the search", () => {
  const rows = ["Color", "Contrast", "Background", "Typeface", "Corners", "Side menu"];
  const appearance = (query: string, overrides: Partial<IndexSources> = {}, admin = true) =>
    searchSettings(index(admin, overrides), query).filter(hit => hitPath(hit).startsWith("You / Appearance · "));

  it("finds each of the six rows by its label, as You / Appearance · Row, opening the tab on the row", () => {
    for (const label of rows) {
      const hit = appearance(label.toLowerCase()).find(found => found.entry.kind === "row" && found.name === label);
      expect(hitPath(hit!), label).toBe(`You / Appearance · ${label}`);
      expect(hit!.target).toEqual({ tab: "appearance", anchor: expect.stringMatching(/^set-/) });
    }
    expect(appearance("side menu")[0].target).toEqual({ tab: "appearance", anchor: "set-side-menu" });
  });

  it("finds a row by the words it is also known by", () => {
    expect(appearance("tint").map(hitPath)).toContain("You / Appearance · Color");
    expect(appearance("legibility").map(hitPath)).toEqual(["You / Appearance · Contrast"]);
    expect(appearance("wallpaper").map(hitPath)).toEqual(["You / Appearance · Background"]);
    expect(appearance("font family").map(hitPath)).toEqual(["You / Appearance · Typeface"]);
    expect(appearance("radius").map(hitPath)).toEqual(["You / Appearance · Corners"]);
    expect(appearance("sidebar").map(hitPath)).toEqual(["You / Appearance · Side menu"]);
  });

  it("finds a row by the words of its current choice, and shows them", () => {
    expect(appearance("heather").map(hitPath)).toContain("You / Appearance · Color");
    const rail = appearance("icons only").find(hit => hit.name === "Side menu");
    expect(rail?.meta).toBe("Layout · Icons only");
    // The card and the row share a name, so the row's line is its choice alone.
    expect(appearance("hex lattice", { look: { ...defaultLook(), background: "hex" } }).find(hit => hit.entry.kind === "row")?.meta)
      .toBe("Hex lattice");
    expect(appearance("always open").find(hit => hit.name === "Side menu")).toBeUndefined();
  });

  it("is there for a member as for an admin, the labels found before the look is read", () => {
    expect(appearance("corners", {}, false).map(hitPath)).toEqual(["You / Appearance · Corners"]);
    expect(appearance("typeface", { look: null }).map(hitPath)).toEqual(["You / Appearance · Typeface"]);
  });
});

describe("what the search finds", () => {
  it("finds a row by the label the person sees, as Group / Tab · Row with its card and value", () => {
    const hits = searchSettings(index(), "query time");
    expect(hitPath(hits[0])).toBe("Instance / Limits · Query time limit");
    expect(hits[0].meta).toBe("Queries · 60 seconds");
    expect(hits[0].target).toEqual({ tab: "limits", anchor: "set-query-time" });
  });

  it("reads a Limits value as its row shows it: a count bare, a rate window every 10 seconds, the largest image per side", () => {
    const limits = (query: string) => searchSettings(index(), query).filter(hit => hitPath(hit).startsWith("Instance / Limits · "));
    expect(limits("tools waiting")[0].meta).toBe("Tools · 20");
    expect(limits("tile requests")[0].meta).toBe("Public requests · 600 every 10 seconds");
    expect(limits("largest image")[0].meta).toBe("Image export · 4,096 px per side");
  });

  it("finds a row by a keyword, by the words of its current value, and by a variable's name", () => {
    expect(paths(searchSettings(index(), "concurrency"))).toContain("Instance / Limits · Tools running at once");
    expect(paths(searchSettings(index(), "atlas north"))).toContain("Instance / General · Instance name");
    const landing = searchSettings(index(), "maps").find(hit => hitPath(hit) === "Instance / General · Landing page");
    expect(landing?.meta).toBe("Sign-in · Maps");
    expect(paths(searchSettings(index(), "DEZFIL_GEOCODER_URL"))).toEqual(["Instance / System · Address finder"]);
    expect(paths(searchSettings(index(), "geocoder.example"))).toContain("Instance / System · Address finder");
    expect(paths(searchSettings(index(), "ada_okafor"))).toEqual(["You / Account · SQL name"]);
    expect(paths(searchSettings(index(), "laptop"))).toEqual(["You / Tokens · Laptop CLI"]);
  });

  it("finds tabs and cards by their names, and lands a card's hit on the card", () => {
    expect(paths(searchSettings(index(), "limits")).slice(0, 1)).toEqual(["Instance / Limits"]);
    const card = searchSettings(index(), "image export")[0];
    expect(hitPath(card)).toBe("Instance / Limits · Image export");
    expect(card.target).toEqual({ tab: "limits", anchor: "limits-images" });
    expect(card.meta).toBe("Largest image, Images at once, Time limit per image");
  });

  it("offers the header's light or dark button, and Users for an admin, as pointers", () => {
    const theme = searchSettings(index(), "dark");
    expect(paths(theme)).toContain("Header / Light or dark");
    expect(theme.find(hit => hitPath(hit) === "Header / Light or dark")?.target).toEqual({ pointer: "theme" });
    expect(paths(searchSettings(index(), "invite"))).toEqual(["Side menu / Users"]);
  });

  it("ranks a label that starts with the words above one that holds them, and both above a keyword", () => {
    const hits = paths(searchSettings(index(), "time limit"));
    expect(hits.indexOf("Instance / Limits · Time limit per tool run")).toBeLessThan(hits.indexOf("Instance / Limits · Query time limit"));
    // A keyword alone: the tabs' order, then the rows' order within a tab.
    const rows = paths(searchSettings(index(), "timeout"));
    expect(rows.slice(0, 4)).toEqual(["Instance / Limits · Link import time limit", "Instance / Limits · Query time limit",
      "Instance / Limits · Time limit per tool run", "Instance / Limits · Time limit per image"]);
    expect(rows.slice(4).every(path => path.startsWith("Instance / System · "))).toBe(true);
  });

  it("finds nothing for words no setting holds", () => {
    expect(searchSettings(index(), "zebra crossing")).toEqual([]);
    expect(searchSettings(index(), "   ")).toEqual([]);
  });
});

describe("what the fields on screen hold now", () => {
  it("finds a row by its field's current text, typed and not yet saved, in place of the served value", () => {
    const live = new Map([["set-display-name", "Ada Lovelace"], ["set-sign-in-message", "Bring your badge."], ["set-token-name", "Nightly sync"]]);
    const built = buildSearchIndex(withLiveValues(settingsDeclarations(sources(), true), live), true);
    expect(paths(searchSettings(built, "lovelace"))).toEqual(["You / Account · Display name"]);
    expect(searchSettings(built, "lovelace")[0].meta).toBe("Account · Ada Lovelace");
    expect(searchSettings(built, "badge")[0].meta).toBe("Sign-in · Bring your badge.");
    expect(paths(searchSettings(built, "nightly"))).toEqual(["You / Tokens · Token name"]);
    // The served text no longer stands for a field that holds other text now.
    expect(paths(searchSettings(built, "work email"))).not.toContain("Instance / General · Message");
    // A row no field registered keeps its served value.
    expect(paths(searchSettings(built, "atlas north"))).toContain("Instance / General · Instance name");
  });
});

describe("what a member's search holds", () => {
  it("holds only the member's tabs: never Limits, System or Users", () => {
    const member = index(false, { instance: null });
    const tabs = new Set(member.map(entry => entry.tab ?? entry.pointer));
    expect([...tabs].sort()).toEqual(["account", "appearance", "general", "theme", "tokens"]);
    for (const query of ["limit", "users", "invite", "environment", "version", "query time"]) {
      expect(paths(searchSettings(member, query)).filter(path => /Limits|System|Users/.test(path))).toEqual([]);
    }
    expect(searchSettings(member, "gis team").map(hitPath)).toEqual(["Instance / General · Lost password contact"]);
  });
});

describe("what the search never reads", () => {
  const PASSWORD = "seeded-Password-4711", SECRET = "dz_seededTokenSecret_0042";
  /** The cards a tab would declare while a password is typed and a new token's secret is on screen. */
  const seeded: IndexCard[] = [
    { id: "account", title: "Account", rows: [
      { id: "set-display-name", label: "Display name", value: "Ada Okafor" },
      { id: "set-current-password", label: "Current password", value: PASSWORD, secret: true },
      { id: "set-new-password", label: "New password", value: PASSWORD, secret: true },
    ] },
  ];
  const tokens: IndexCard[] = [
    { id: "tokens", title: "API / MCP tokens", rows: [{ id: "tokens-secret", label: "New token", value: SECRET, secret: true }] },
  ];

  it("never finds a password or a token secret, by its value or its field", () => {
    const seededIndex = buildSearchIndex({ account: seeded, tokens }, true);
    for (const query of [PASSWORD, SECRET, "seeded", "dz_", "New token", "New password"]) {
      expect(searchSettings(seededIndex, query).map(hitPath)).toEqual([]);
    }
    expect(JSON.stringify(seededIndex)).not.toMatch(/seeded|dz_/);
    // The rest of the card is still found.
    expect(searchSettings(seededIndex, "display").map(hitPath)).toEqual(["You / Account · Display name"]);
  });

  it("never reads a password or a token secret registered as a field's current text", () => {
    const live = new Map([
      ["set-current-password", PASSWORD], ["set-new-password", PASSWORD], ["set-current-password-email", PASSWORD],
      ["tokens-secret", SECRET], ["set-display-name", "Ada Lovelace"],
    ]);
    const built = buildSearchIndex(withLiveValues(settingsDeclarations(sources(), true), live), true);
    expect(JSON.stringify(built)).not.toMatch(/seeded|dz_/);
    for (const query of [PASSWORD, SECRET, "seeded", "dz_"]) expect(searchSettings(built, query).map(hitPath)).toEqual([]);
    // The plain field registered beside them is found by what it holds.
    expect(paths(searchSettings(built, "lovelace"))).toEqual(["You / Account · Display name"]);
  });

  it("keeps a token's secret out even when the token's record carries one", () => {
    const carried = [{ ...TOKENS[0], secret: SECRET }];
    const built = buildSearchIndex(settingsDeclarations(sources({ tokens: carried }), true), true);
    expect(JSON.stringify(built)).not.toContain(SECRET);
    expect(searchSettings(built, SECRET)).toEqual([]);
  });
});
