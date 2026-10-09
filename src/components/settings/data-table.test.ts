import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GOVERNED_REQUESTS } from "@/lib/net/governed-requests";
import { readInstanceSettings } from "@/lib/settings/read";
import { SERVICE_ADDRESS_KEYS } from "@/lib/settings/service-address";
import { writeStoredSettings } from "@/lib/settings/store";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";
import {
  addressRows, addressState, addressWords, cacheShare, cacheWords, cardSetUp, checkedWords, DATA_CARDS, DATA_LABELS, DATA_ROW_IDS,
  dataRowAddress, governedNote, lockedLines, numberWords, pageRange, releaseListWords, serviceNumberRows, sizeWords, testAnswerWords,
  toApi, toPage,
} from "./data-table";
import { limitsSettingRows } from "./limits-table";
import { CONNECTIONS_CARD, RULE_CHOICE_WORDS } from "./security-table";

/**
 * The Data & services table, held against the configuration read the
 * server answers: every service number an admin may store has a row
 * with its page unit and scale, every address an admin may store has its
 * row, the two values only the environment sets are drawn locked, and
 * every row names a setting the read carries. The page's bounds are the
 * read's converted, and the scale holds both ways, so a typed 1.2 seconds
 * is never stored as 1.2 milliseconds.
 */

let fixture: ReturnType<typeof instanceSettingsFixture>;
beforeEach(() => { fixture = instanceSettingsFixture(); });
afterEach(() => fixture.close());
// Through the wire, as the page receives it.
const read = () => JSON.parse(JSON.stringify(readInstanceSettings(fixture.context, fixture.db)));
type Read = Record<string, { kind: string; editable: boolean; environment?: string; unit?: string; defaultValue: unknown;
  write?: { kind: string; min?: number; max?: number; values?: string[] } }>;

const SERVICE_NUMBERS = ["geocodePaceMs", "geocodeRequestTimeoutS", "geocodeMatchCacheHours", "isochronePaceMs",
  "isochroneRequestTimeoutS", "isochroneCacheHours", "overpassTimeoutS", "overpassCacheHours"];

describe("the Data & services table against the read", () => {
  it("gives each of the eight service numbers and the four addresses a row, and names nothing the read lacks", () => {
    const settings: Read = read().settings;
    const numbers = serviceNumberRows().map(row => row.key);
    expect([...numbers].sort()).toEqual([...SERVICE_NUMBERS].sort());
    for (const key of numbers) {
      expect(settings[key].kind, key).toBe("number");
      expect(settings[key].editable, key).toBe(true);
      expect(settings[key].environment, key).toMatch(/^DEZFIL_/);
    }
    const addresses = addressRows().map(row => row.key);
    expect([...addresses].sort()).toEqual([...SERVICE_ADDRESS_KEYS].sort());
    for (const key of addresses) {
      expect(settings[key].kind, key).toBe("address");
      expect(settings[key].write?.kind, key).toBe("address");
      expect(settings[key].environment, key).toMatch(/^DEZFIL_/);
    }
    // Every number an admin may store with its variable is drawn on Limits or here, never on both.
    const limits = limitsSettingRows().map(row => row.key);
    const variables = Object.entries(settings).filter(([, setting]) => setting.kind === "number" && setting.editable && setting.environment).map(([key]) => key);
    expect([...limits, ...numbers].filter(key => settings[key].editable).sort()).toEqual([...variables].sort());
    expect(limits.filter(key => numbers.includes(key as never))).toEqual([]);
    const ids = DATA_CARDS.flatMap(card => [card.id, ...card.rows.map(row => row.id)]).concat(CONNECTIONS_CARD.id, ...CONNECTIONS_CARD.rows.map(row => row.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("draws the credentials switch and the allowlist locked, as values only the environment sets", () => {
    const settings: Read = read().settings;
    const locked = DATA_CARDS.flatMap(card => card.rows).flatMap(row => row.kind === "locked" ? [row.key] : []);
    expect(locked).toEqual(["objectStoreCredentials", "egressAllowlist"]);
    for (const key of locked) {
      expect(settings[key].editable, key).toBe(false);
      expect(settings[key].environment, key).toMatch(/^DEZFIL_/);
    }
    expect(lockedLines({ kind: "locked", key: "egressAllowlist", id: "", label: "", keys: "" }, ["10.20.0.0/16", "gis-db.internal"])).toEqual(["10.20.0.0/16", "gis-db.internal"]);
    expect(lockedLines({ kind: "locked", key: "egressAllowlist", id: "", label: "", keys: "" }, [])).toEqual([]);
    expect(lockedLines({ kind: "locked", key: "objectStoreCredentials", id: "", label: "", keys: "" }, true)).toEqual(["On"]);
  });

  it("draws who may add connections and import from links, worded as the read offers them", () => {
    const settings: Read = read().settings;
    expect(CONNECTIONS_CARD.rows.map(row => [row.label, row.fields.map(field => field.key)])).toEqual([
      ["Who may add database connections", ["connections.create"]], ["Who may import from links", ["imports.links"]],
    ]);
    for (const key of ["connections.create", "imports.links"] as const) {
      expect(Object.keys(RULE_CHOICE_WORDS[key])).toEqual(settings[key].write!.values);
      expect(settings[key].environment).toBeUndefined();
    }
  });

  it("lays out the cards in the order and under the labels the page shows", () => {
    expect([...DATA_CARDS.map(card => [card.title, card.rows.map(row => row.label)]), [CONNECTIONS_CARD.title, CONNECTIONS_CARD.rows.map(row => row.label)]]).toEqual([
      ["Address finder", ["Address", "Gap between requests", "Answer time limit", "Keep found addresses for", "Cache"]],
      ["Travel time", ["Address", "Gap between requests", "Answer time limit", "Keep areas for", "Cache"]],
      ["OpenStreetMap", ["Address", "Time budget per query", "Keep answers for", "Cache"]],
      ["Overture Maps", ["Release list"]],
      ["Cloud storage", ["S3 address", "Read with the server’s credentials"]],
      ["Private network", ["Hosts the server may reach"]],
      ["Connections and imports", ["Who may add database connections", "Who may import from links"]],
    ]);
    // A Test at the head of every service card but Overture's, whose Test is Check now.
    expect(DATA_CARDS.map(card => [card.id, card.test ?? null, card.needs ?? null])).toEqual([
      ["data-geocoder", "geocode", "geocoderUrl"], ["data-travel", "isochrone", "isochroneUrl"], ["data-osm", "overpass", null],
      ["data-overture", null, null], ["data-storage", "s3", null], ["data-private", null, null],
    ]);
  });
});

describe("the page's units", () => {
  it("takes the mockup's bounds, which are the read's in the variable's unit converted", () => {
    const settings: Read = read().settings;
    const shown = Object.fromEntries(serviceNumberRows().map(row => [row.key, { ...pageRange(row, settings[row.key].write as never), unit: row.unit, places: row.places }]));
    expect(shown).toEqual({
      geocodePaceMs: { min: 0, max: 60, unit: "seconds", places: 1 },
      geocodeRequestTimeoutS: { min: 1, max: 120, unit: "seconds", places: 0 },
      geocodeMatchCacheHours: { min: 1, max: 365, unit: "days", places: 0 },
      isochronePaceMs: { min: 0, max: 60, unit: "seconds", places: 0 },
      isochroneRequestTimeoutS: { min: 1, max: 120, unit: "seconds", places: 0 },
      isochroneCacheHours: { min: 1, max: 365, unit: "days", places: 0 },
      overpassTimeoutS: { min: 10, max: 900, unit: "seconds", places: 0 },
      overpassCacheHours: { min: 1, max: 720, unit: "hours", places: 0 },
    });
    // The defaults read in the page's units as the spec gives them.
    expect(Object.fromEntries(serviceNumberRows().map(row => [row.key, toPage(row, settings[row.key].defaultValue)]))).toEqual({
      geocodePaceMs: 1, geocodeRequestTimeoutS: 10, geocodeMatchCacheHours: 30, isochronePaceMs: 1,
      isochroneRequestTimeoutS: 20, isochroneCacheHours: 7, overpassTimeoutS: 60, overpassCacheHours: 24,
    });
  });

  it("converts both ways: what the page takes is stored in the variable's unit and read back as it was typed", () => {
    const row = (key: string) => serviceNumberRows().find(each => each.key === key)!;
    expect(toApi(row("geocodePaceMs"), 1.2)).toBe(1200);
    expect(toApi(row("geocodePaceMs"), 0.3)).toBe(300);
    expect(toApi(row("isochronePaceMs"), 2)).toBe(2000);
    expect(toApi(row("geocodeMatchCacheHours"), 30)).toBe(720);
    expect(toApi(row("overpassCacheHours"), 48)).toBe(48);
    expect(toPage(row("geocodePaceMs"), 1200)).toBe(1.2);
    expect(toPage(row("geocodeMatchCacheHours"), 720)).toBe(30);
    // A value stored off the page's grid shows as it is, never rounded onto it.
    expect(toPage(row("isochronePaceMs"), 1500)).toBe(1.5);
    expect(toPage(row("isochroneCacheHours"), 36)).toBe(1.5);
    for (const each of serviceNumberRows()) {
      for (const value of [0, 1, 7, 30, 60]) expect(toPage(each, toApi(each, value)), each.key).toBe(value);
    }
    // Through the store: a typed 1.2 seconds is kept as 1,200 milliseconds and read back as 1.2.
    writeStoredSettings({ geocodePaceMs: toApi(row("geocodePaceMs"), 1.2) }, fixture.db);
    const settings: Read = read().settings;
    expect((settings.geocodePaceMs as unknown as { value: number }).value).toBe(1200);
    expect(numberWords(row("geocodePaceMs"), (settings.geocodePaceMs as unknown as { value: number }).value)).toBe("1.2 seconds");
    expect(numberWords(row("geocodeMatchCacheHours"), 720)).toBe("30 days");
  });
});

describe("where the rows are", () => {
  it("gives every stored address and number its row's address inside the tab", () => {
    expect(Object.keys(DATA_ROW_IDS).sort()).toEqual([...SERVICE_NUMBERS, ...SERVICE_ADDRESS_KEYS].sort());
    expect(dataRowAddress("geocoderUrl")).toBe("/settings/data#set-geocoder-address");
    expect(dataRowAddress("isochroneUrl")).toBe("/settings/data#set-travel-address");
    expect(dataRowAddress("geocodePaceMs")).toBe("/settings/data#set-geocoder-gap");
    expect(dataRowAddress("queryTimeoutS")).toBeNull();
    expect(DATA_LABELS).toMatchObject({ geocodePaceMs: "Gap between requests", overpassTimeoutS: "Time budget per query", s3Endpoint: "S3 address" });
  });
});

describe("what an address row shows", () => {
  const row = (key: string) => addressRows().find(each => each.key === key)!;

  it("says only what the read discloses: scheme and host, the default, set and unreadable, or Not set up", () => {
    vi.stubEnv("DEZFIL_GEOCODER_URL", "https://seed-user:SEEDED-KEY-0001-USER@geocoder.example/SEEDED-KEY-0001-PATH?key=SEEDED-KEY-0001-QUERY");
    const settings = read().settings;
    expect(addressWords(row("geocoderUrl"), settings.geocoderUrl)).toBe("https://geocoder.example");
    expect(JSON.stringify(settings.geocoderUrl)).not.toContain("SEEDED-KEY");
    expect(addressState(row("isochroneUrl"), settings.isochroneUrl)).toEqual({ kind: "none" });
    expect(addressWords(row("isochroneUrl"), settings.isochroneUrl)).toBe("Not set up");
    expect(addressState(row("overpassUrl"), settings.overpassUrl)).toEqual({ kind: "default", text: "https://overpass-api.de", mono: true });
    expect(addressState(row("s3Endpoint"), settings.s3Endpoint)).toEqual({ kind: "default", text: "Amazon S3", mono: false });
    expect(addressState(row("overpassUrl"), { source: "stored", value: { set: true, origin: "https://osm.example" } })).toEqual({ kind: "saved", origin: "https://osm.example" });
    expect(addressState(row("overpassUrl"), { source: "stored", value: { set: true, unreadable: true } })).toEqual({ kind: "unreadable" });
    expect(addressWords(row("overpassUrl"), { source: "stored", value: { set: true, unreadable: true } })).toBe("Set");
  });

  it("collapses the address finder and travel time to their address while the read reports it not set", () => {
    const [geocoder, travel, osm] = DATA_CARDS;
    expect(cardSetUp(geocoder, { geocoderUrl: { value: { set: false } } })).toBe(false);
    expect(cardSetUp(geocoder, { geocoderUrl: { value: { set: true, origin: "https://geocoder.example" } } })).toBe(true);
    expect(cardSetUp(geocoder, { geocoderUrl: { value: { set: true, unreadable: true } } })).toBe(true);
    expect(cardSetUp(travel, { isochroneUrl: { value: { set: false } } })).toBe(false);
    expect(cardSetUp(osm, {})).toBe(true);
  });
});

describe("the words the tab shows", () => {
  it("names exactly the requests the egress check governs in the Private network note", () => {
    const note = governedNote();
    expect(note).toBe("Every other private address is refused for imports and refreshes from web addresses, cloud storage links read without the server's credentials, database connections, the address finder and place search, travel time, OpenStreetMap, the Overture release list, custom basemap styles and map image exports.");
    for (const request of GOVERNED_REQUESTS) expect(note.toLowerCase()).toContain(request.label.toLowerCase());
  });

  it("says a cache's use against its budget and how many answers, or Empty", () => {
    expect(cacheWords("geocode", { bytes: 3.1 * 1024 * 1024, answers: 1284, budgetMb: 64 })).toBe("3.1 MB of 64 MB · 1,284 addresses");
    expect(cacheWords("overpass", { bytes: 1228.8 * 1024 * 1024, answers: 312, budgetMb: 2048 })).toBe("1.2 GB of 2 GB · 312 answers");
    expect(cacheWords("isochrone", { bytes: 2048, answers: 1, budgetMb: 64 })).toBe("2 KB of 64 MB · 1 area");
    expect(cacheWords("isochrone", { bytes: 0, answers: 0, budgetMb: 64 })).toBe("Empty");
    expect(cacheShare({ bytes: 32 * 1024 * 1024, answers: 2, budgetMb: 64 })).toBe(50);
    expect(cacheShare({ bytes: 128 * 1024 * 1024, answers: 2, budgetMb: 64 })).toBe(100);
    expect(sizeWords(20 * 1024 * 1024)).toBe("20 MB");
  });

  it("says the release list's count, newest and when it was checked", () => {
    const now = Date.parse("2026-10-09T12:00:00.000Z");
    expect(releaseListWords({ listed: false }, now)).toBe("Not checked yet");
    expect(releaseListWords({ listed: true, releases: 5, newest: "2026-09-17.0", listedAt: "2026-10-09T10:00:00.000Z" }, now))
      .toBe("5 releases, newest 2026-09-17.0 · Checked 2 hours ago");
    expect(checkedWords("2026-10-09T11:59:30.000Z", now)).toBe("Checked just now");
    expect(checkedWords("2026-10-09T11:59:00.000Z", now)).toBe("Checked 1 minute ago");
    expect(checkedWords("2026-10-07T11:00:00.000Z", now)).toBe("Checked 2 days ago");
  });

  it("says a Test's answer from its closed shape and nothing else", () => {
    expect(testAnswerWords({ service: "geocode", result: "passed", milliseconds: 180 })).toEqual({ passed: true, text: "Answered in 180 ms" });
    expect(testAnswerWords({ service: "overture", result: "passed", releases: 5, newest: "2026-09-17.0" })).toEqual({ passed: true, text: "5 releases, newest 2026-09-17.0" });
    expect(testAnswerWords({ service: "isochrone", result: "failed", reason: "not_set_up" }).text).toBe("Not set up.");
    expect(testAnswerWords({ service: "overpass", result: "failed", reason: "refused", message: "The address is in private space." }).text).toBe("The address is in private space.");
    expect(testAnswerWords({ service: "s3", result: "failed", reason: "unreachable" }).text).toBe("Could not reach the service.");
    expect(testAnswerWords({ service: "s3", result: "failed", reason: "timed_out" }).text).toBe("No answer within the time limit.");
    expect(testAnswerWords({ service: "geocode", result: "failed", reason: "status", status: 503 })).toEqual({ passed: false, text: "Answered with status 503." });
    expect(testAnswerWords({ service: "geocode", result: "failed", reason: "unexpected_answer" }).text).toBe("Answered, but not as the service does.");
  });
});
