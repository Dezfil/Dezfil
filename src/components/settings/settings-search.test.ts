import { describe, expect, it } from "vitest";
import type { Account } from "@/lib/metadata/accounts";
import { defaultLook } from "@/lib/look";
import { instanceReadFixture, type Resolution } from "./read-fixture";
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
  { id: "t1", name: "Laptop CLI", createdAt: "2026-10-01T00:00:00.000Z", lastUsedAt: null, revokedAt: null, expiresAt: null },
  { id: "t2", name: "Old script", createdAt: "2026-09-01T00:00:00.000Z", lastUsedAt: null, revokedAt: "2026-09-20T00:00:00.000Z", expiresAt: null },
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

  it("finds each part on System's Status by its name, its program and its state, as its row shows it before a Test", () => {
    const status = (query: string) => searchSettings(index(), query).filter(hit => hit.meta?.startsWith("Status · "));
    expect(status("tippecanoe").map(hit => [hitPath(hit), hit.meta])).toEqual([["Instance / System · Tile builder", "Status · tippecanoe Found"]]);
    // Storage's rows are another card's: none of them is a Status hit.
    expect(status("metadata").map(hitPath)).toEqual(["Instance / System · Metadata database"]);
    expect(status("duckdb").map(hit => [hitPath(hit), hit.meta])).toEqual([["Instance / System · Query engine", "Status · DuckDB 1.5.4 Not started yet"]]);
    expect(status("at once").map(hitPath)).toEqual(["Instance / System · Image renderer"]);
    expect(status("metadata.sqlite").map(hitPath)).toEqual(["Instance / System · Metadata database"]);
    expect(status("data folder").map(hit => [hitPath(hit), hit.meta])).toEqual([["Instance / System · Data folder", "Status · /srv/dezfil Writable"]]);
    // A program not where its setting points is found by its state.
    const read = sources().instance!;
    const missing = { ...read, parts: { ...read.parts, tile_builder: { found: false, version: null } } };
    expect(searchSettings(index(true, { instance: missing }), "not found").map(hitPath)).toContain("Instance / System · Tile builder");
  });

  it("finds each kind on System's Storage by its name and its words, and Free on the disk, opening the tab on the row", () => {
    const storage = (query: string) => searchSettings(index(), query).filter(hit => hit.meta === "Storage");
    expect(storage("leftover").map(hit => [hitPath(hit), hit.target])).toEqual([["Instance / System · Leftover files", { tab: "system", anchor: "sys-leftovers" }]]);
    expect(storage("scratch").map(hitPath)).toEqual(["Instance / System · Leftover files"]);
    expect(storage("pmtiles").map(hitPath)).toEqual(["Instance / System · Tile archives"]);
    expect(storage("geocode").map(hitPath)).toEqual(["Instance / System · Service caches"]);
    expect(storage("thumbnails").map(hitPath)).toEqual(["Instance / System · Thumbnails"]);
    expect(storage("free on the disk").map(hitPath)).toEqual(["Instance / System · Free on the disk"]);
    expect(storage("tables").map(hitPath)).toContain("Instance / System · Tables");
    expect(storage("metadata").map(hitPath)).toEqual(["Instance / System · Metadata database"]);
    expect(storage("other").map(hitPath)).toContain("Instance / System · Other");
    // The card itself, by its name and its words.
    expect(searchSettings(index(), "disk usage").find(hit => hit.entry.kind === "card" && hit.name === "Storage")?.target)
      .toEqual({ tab: "system", anchor: "system-storage" });
  });

  it("finds tabs and cards by their names, and lands a card's hit on the card", () => {
    expect(paths(searchSettings(index(), "limits")).slice(0, 1)).toEqual(["Instance / Limits"]);
    // Two cards share the name: Publishing's comes first, in the column's order.
    const cards = searchSettings(index(), "image export").filter(hit => hit.entry.kind === "card");
    expect(cards.map(hitPath)).toEqual(["Instance / Publishing · Image export", "Instance / Limits · Image export"]);
    expect(cards.map(hit => hit.target)).toEqual([{ tab: "publishing", anchor: "publishing-export" }, { tab: "limits", anchor: "limits-images" }]);
    expect(cards.map(hit => hit.meta)).toEqual(["Starting width, Starting shape", "Largest image, Images at once, Time limit per image"]);
    expect(paths(searchSettings(index(), "workflows")).slice(0, 1)).toEqual(["Instance / Workflows & SQL"]);
    expect(searchSettings(index(), "workflows")[0].meta).toBe("Workflow canvas, SQL console");
  });

  it("offers the header's light or dark button, and Users for an admin, as pointers", () => {
    const theme = searchSettings(index(), "dark");
    expect(paths(theme)).toContain("Header / Light or dark");
    expect(theme.find(hit => hitPath(hit) === "Header / Light or dark")?.target).toEqual({ pointer: "theme" });
    // Security's row for invite links starts with the word; Users holds it as a keyword.
    expect(paths(searchSettings(index(), "invite"))).toEqual(["Instance / Security · Invite and reset links last", "Side menu / Users"]);
  });

  it("ranks a label that starts with the words above one that holds them, and both above a keyword", () => {
    const hits = paths(searchSettings(index(), "time limit"));
    expect(hits.indexOf("Instance / Limits · Time limit per tool run")).toBeLessThan(hits.indexOf("Instance / Limits · Query time limit"));
    // A keyword alone: the tabs' order, then the rows' order within a tab.
    const rows = paths(searchSettings(index(), "timeout"));
    expect(rows.slice(0, 6)).toEqual(["Instance / Data & services · Answer time limit", "Instance / Data & services · Time budget per query",
      "Instance / Limits · Link import time limit", "Instance / Limits · Query time limit",
      "Instance / Limits · Time limit per tool run", "Instance / Limits · Time limit per image"]);
    expect(rows.slice(6).every(path => path.startsWith("Instance / System · "))).toBe(true);
  });

  it("finds nothing for words no setting holds", () => {
    expect(searchSettings(index(), "zebra crossing")).toEqual([]);
    expect(searchSettings(index(), "   ")).toEqual([]);
  });
});

describe("Data & services in the search", () => {
  it("finds a service's rows by their words and what the read discloses, a service with no address by its address row alone", () => {
    const built = index(true, { instance: instanceReadFixture({
      geocoderUrl: { value: { set: true, origin: "https://geocoder.example" }, source: "stored", storedValue: null },
      geocodePaceMs: { value: 1500, source: "stored", storedValue: 1500 },
    }, { services: { geocode: { bytes: 2 * 1024 * 1024, answers: 12, budgetMb: 64 }, isochrone: { bytes: 0, answers: 0, budgetMb: 64 },
      overpass: { bytes: 0, answers: 0, budgetMb: 2048 }, overture: { listed: false } } }) });
    const hit = (query: string, path: string) => searchSettings(built, query).find(each => hitPath(each) === path);
    expect(hit("geocoder.example", "Instance / Data & services · Address")?.meta).toBe("Address finder · https://geocoder.example");
    expect(hit("gap", "Instance / Data & services · Gap between requests")?.meta).toBe("Address finder · 1.5 seconds");
    expect(hit("12 addresses", "Instance / Data & services · Cache")?.meta).toBe("Address finder · 2 MB of 64 MB · 12 addresses");
    expect(hit("release list", "Instance / Data & services · Release list")?.meta).toBe("Overture Maps · Not checked yet");
    expect(hit("allowlist", "Instance / Data & services · Hosts the server may reach")?.meta).toBe("Private network · None");
    expect(hit("who may import", "Instance / Data & services · Who may import from links")?.meta).toBe("Connections and imports · Everyone");
    // Travel time has no address: its address row is found, and none of the rows its card does not draw.
    const travel = searchSettings(built, "travel time").filter(each => each.entry.kind === "row" && each.entry.card === "Travel time");
    expect(travel.map(hitPath)).toEqual(["Instance / Data & services · Address"]);
    expect(travel[0].meta).toBe("Travel time · Not set up");
  });

  it("lists none of Data & services for a member", () => {
    const built = index(false);
    for (const query of ["address finder", "gap between requests", "cache", "overpass", "private network", "who may import", "s3 address"]) {
      expect(paths(searchSettings(built, query)).filter(path => path.includes("Data & services")), query).toEqual([]);
    }
  });
});

describe("what new things start with, in the search", () => {
  /** The read with these values stored, as the server reports a kept value. */
  const keeping = (values: Record<string, unknown>, extra: Record<string, Resolution> = {}) => ({
    instance: instanceReadFixture({
      ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value, source: "stored" as const, storedValue: value }])),
      ...extra,
    }),
  });
  const row = (built: ReturnType<typeof index>, query: string, path: string) =>
    searchSettings(built, query).find(hit => hit.entry.kind === "row" && hitPath(hit) === path);

  /** Each row as the three tabs show it at the product's values: its tab, its label, its address, its card and value. */
  const ROWS: readonly (readonly [string, string, string, string, string])[] = [
    ["Maps", "Basemap", "maps", "set-basemap", "New maps · Auto"],
    ["Maps", "Starting view", "maps", "set-starting-view", "New maps · Latitude 40, longitude 0, zoom 1.3"],
    ["Maps", "Legend corner", "maps", "set-legend-corner", "Legend · Bottom left"],
    ["Maps", "Color cycle", "maps", "set-color-cycle", "New layers · Viz Qualitative"],
    ["Maps", "Opacity", "maps", "set-opacity", "New layers · Points 72 %, lines 95 %, areas 50 %"],
    ["Maps", "Line width", "maps", "set-line-width", "New layers · 2 px"],
    ["Maps", "Point radius", "maps", "set-point-radius", "New layers · 3 px"],
    ["Workflows & SQL", "Canvas opens", "workflows", "set-canvas-opens", "Workflow canvas · Full screen"],
    ["Workflows & SQL", "Minimap", "workflows", "set-minimap", "Workflow canvas · Automatic"],
    ["Workflows & SQL", "Results band", "workflows", "set-results-band", "Workflow canvas · Closed"],
    ["Workflows & SQL", "Text size", "workflows", "set-sql-text-size", "SQL console · 12 px"],
    ["Workflows & SQL", "Line wrap", "workflows", "set-sql-line-wrap", "SQL console · Off"],
    ["Publishing", "Starting width", "publishing", "set-export-width", "Image export · 1920 px"],
    ["Publishing", "Starting shape", "publishing", "set-export-shape", "Image export · 4:3"],
  ];

  it("finds every row by its label as Instance / Tab · Row, with its card and its value, opening its tab on the row", () => {
    for (const [tab, label, id, anchor, meta] of ROWS) {
      const hit = row(index(), label.toLowerCase(), `Instance / ${tab} · ${label}`);
      expect(hit, label).toBeDefined();
      expect(hit!.meta, label).toBe(meta);
      expect(hit!.target, label).toEqual({ tab: id, anchor });
    }
    // The tabs and their cards are found by name too.
    expect(paths(searchSettings(index(), "maps")).slice(0, 1)).toEqual(["Instance / Maps"]);
    expect(searchSettings(index(), "maps")[0].meta).toBe("New maps, Legend, New layers");
    expect(paths(searchSettings(index(), "publishing")).slice(0, 1)).toEqual(["Instance / Publishing"]);
    const layers = searchSettings(index(), "new layers").find(hit => hit.entry.kind === "card");
    expect(hitPath(layers!)).toBe("Instance / Maps · New layers");
    expect(layers!.target).toEqual({ tab: "maps", anchor: "card-new-layers" });
    expect(layers!.meta).toBe("Color cycle, Opacity, Line width, Point radius");
  });

  it("finds a row by a word it is also known by", () => {
    expect(paths(searchSettings(index(), "aspect ratio"))).toEqual(["Instance / Publishing · Starting shape"]);
    expect(paths(searchSettings(index(), "navigator"))).toEqual(["Instance / Workflows & SQL · Minimap"]);
    expect(paths(searchSettings(index(), "transparency"))).toEqual(["Instance / Maps · Opacity"]);
    expect(paths(searchSettings(index(), "soft wrap"))).toEqual(["Instance / Workflows & SQL · Line wrap"]);
  });

  it("finds a row by the words of the value kept, and no longer by the value it left", () => {
    const kept = index(true, keeping({
      "newLayer.colorCycle": "tab10", "canvas.minimap": "always", "newMap.latitude": 51.5, "newMap.longitude": -0.12,
      "sqlConsole.lineWrap": true, "imageExport.width": "2560", "newLayer.lineOpacity": 35, "newMap.legendCorner": "top-right",
    }));
    expect(paths(searchSettings(kept, "tab10"))).toEqual(["Instance / Maps · Color cycle"]);
    expect(row(kept, "tab10", "Instance / Maps · Color cycle")!.meta).toBe("New layers · Tab10");
    expect(paths(searchSettings(index(), "tab10"))).toEqual([]);
    expect(row(kept, "always", "Instance / Workflows & SQL · Minimap")!.meta).toBe("Workflow canvas · Always");
    expect(row(kept, "51.5", "Instance / Maps · Starting view")!.meta).toBe("New maps · Latitude 51.5, longitude -0.12, zoom 1.3");
    expect(row(kept, "2560", "Instance / Publishing · Starting width")!.meta).toBe("Image export · 2560 px");
    expect(row(kept, "line wrap", "Instance / Workflows & SQL · Line wrap")!.meta).toBe("SQL console · On");
    expect(row(kept, "opacity", "Instance / Maps · Opacity")!.meta).toBe("New layers · Points 72 %, lines 35 %, areas 50 %");
    expect(row(kept, "top right", "Instance / Maps · Legend corner")!.meta).toBe("Legend · Top right");
    expect(paths(searchSettings(kept, "viz qualitative"))).toEqual([]);
  });

  it("reads a stored Satellite as the tab shows it: Auto while the instance offers no imagery, Satellite once it does", () => {
    const without = index(true, keeping({ "newMap.basemap": "satellite" }));
    expect(row(without, "basemap", "Instance / Maps · Basemap")!.meta).toBe("New maps · Auto");
    const imagery = { satelliteUrl: { value: { set: true, origin: "https://imagery.example" }, source: "environment" as const, locked: true } };
    const offered = index(true, keeping({ "newMap.basemap": "satellite" }, imagery));
    expect(row(offered, "basemap", "Instance / Maps · Basemap")!.meta).toBe("New maps · Satellite");
  });

  it("declares nothing of them until the configuration read has answered", () => {
    const unread = index(true, { instance: null });
    expect(unread.filter(entry => ["maps", "workflows", "publishing"].includes(entry.tab ?? "")).map(entry => entry.kind)).toEqual(["tab", "tab", "tab"]);
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
  const ADMIN_ONLY = /Maps|Workflows|Publishing|Limits|Security|System|Users/;
  const QUERIES = ["limit", "users", "invite", "environment", "version", "query time", "maps", "basemap", "starting view", "legend",
    "color cycle", "opacity", "radius", "workflows", "canvas", "minimap", "results band", "text size", "line wrap", "publishing",
    "starting width", "starting shape", "export", "new layers", "viz qualitative", "1920", "security", "stay signed in", "reset links",
    "failed sign-ins", "shortest password", "who may create tokens", "tokens expire", "who may publish", "embedding", "listed sites",
    "public links", "30 days", "any site"];

  it("holds only the member's tabs: never Maps, Workflows & SQL, Publishing, Limits, System or Users", () => {
    const member = index(false, { instance: null });
    const tabs = new Set(member.map(entry => entry.tab ?? entry.pointer));
    expect([...tabs].sort()).toEqual(["account", "appearance", "general", "theme", "tokens"]);
    for (const query of QUERIES) {
      expect(paths(searchSettings(member, query)).filter(path => ADMIN_ONLY.test(path)), query).toEqual([]);
    }
    expect(searchSettings(member, "gis team").map(hitPath)).toEqual(["Instance / General · Lost password contact"]);
  });

  it("holds none of the admins' tabs even when handed the configuration read", () => {
    const handed = index(false);
    expect([...new Set(handed.map(entry => entry.tab ?? entry.pointer))].sort()).toEqual(["account", "appearance", "general", "theme", "tokens"]);
    for (const query of QUERIES) expect(paths(searchSettings(handed, query)).filter(path => ADMIN_ONLY.test(path)), query).toEqual([]);
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

describe("Security and Public links in the search", () => {
  const keeping = (values: Record<string, unknown>) => ({
    instance: instanceReadFixture(Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value, source: "stored" as const, storedValue: value }]))),
  });
  const row = (built: ReturnType<typeof index>, query: string, path: string) =>
    searchSettings(built, query).find(hit => hit.entry.kind === "row" && hitPath(hit) === path);
  const ROWS: readonly (readonly [string, string, string, string, string])[] = [
    ["Security", "Stay signed in for", "security", "set-session-length", "Sign-in · 30 days"],
    ["Security", "Invite and reset links last", "security", "set-link-lifetime", "Sign-in · 7 days"],
    ["Security", "Failed sign-ins before a pause", "security", "set-sign-in-attempts", "Sign-in · 5 per account, 20 per address"],
    ["Security", "Shortest password", "security", "set-password-length", "Sign-in · 8 characters"],
    ["Security", "Who may create tokens", "security", "set-who-tokens", "API tokens · Everyone"],
    ["Security", "New tokens expire after", "security", "set-token-expiry", "API tokens · Never"],
    ["Publishing", "Who may publish", "publishing", "set-who-may-publish", "Public links · Everyone"],
    ["Publishing", "Embedding on other sites", "publishing", "set-embedding", "Public links · Any site"],
  ];

  it("finds every row by its label as Instance / Tab · Row, with its card and its value, opening its tab on the row", () => {
    for (const [tab, label, id, anchor, meta] of ROWS) {
      const hit = row(index(), label.toLowerCase(), `Instance / ${tab} · ${label}`);
      expect(hit, label).toBeDefined();
      expect(hit!.meta, label).toBe(meta);
      expect(hit!.target, label).toEqual({ tab: id, anchor });
    }
    expect(paths(searchSettings(index(), "security")).slice(0, 1)).toEqual(["Instance / Security"]);
    expect(searchSettings(index(), "security")[0].meta).toBe("Sign-in, API tokens");
    expect(searchSettings(index(), "publishing")[0].meta).toBe("Public links, Image export");
    const links = searchSettings(index(), "public links").find(hit => hit.entry.kind === "card");
    expect(hitPath(links!)).toBe("Instance / Publishing · Public links");
    expect(links!.target).toEqual({ tab: "publishing", anchor: "publishing-public" });
  });

  it("finds a row by a word it is also known by, and by the words of the value kept", () => {
    expect(paths(searchSettings(index(), "brute force"))).toEqual(["Instance / Security · Failed sign-ins before a pause"]);
    expect(paths(searchSettings(index(), "iframe"))).toEqual(["Instance / Publishing · Embedding on other sites"]);
    const kept = index(true, keeping({ "tokens.expiry": "1y", "publishing.embedding": "listed", "publishing.embedSites": ["https://www.stadtwerke.example"], "security.passwordMin": 14 }));
    expect(row(kept, "1 year", "Instance / Security · New tokens expire after")!.meta).toBe("API tokens · 1 year");
    expect(row(kept, "stadtwerke", "Instance / Publishing · Embedding on other sites")!.meta).toBe("Public links · Listed sites: https://www.stadtwerke.example");
    expect(row(kept, "shortest password", "Instance / Security · Shortest password")!.meta).toBe("Sign-in · 14 characters");
    expect(paths(searchSettings(index(), "stadtwerke"))).toEqual([]);
  });

  it("declares nothing of them until the configuration read has answered", () => {
    const unread = index(true, { instance: null });
    expect(unread.filter(entry => entry.tab === "security").map(entry => entry.kind)).toEqual(["tab"]);
  });
});
