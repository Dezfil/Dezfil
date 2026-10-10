import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The save-time check's lookup, answered here: every address resolves to a
// documentation address, and the style is never fetched.
const dns = vi.hoisted(() => ({ lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]) }));
vi.mock("node:dns/promises", () => ({ lookup: dns.lookup }));

import { BASEMAP_KEYS, OFFERED_SETTING } from "@/lib/basemap";
import { addLibraryStyle, admitStyleInput } from "@/lib/basemap-library";
import { readInstanceSettings } from "@/lib/settings/read";
import { writeStoredSettings } from "@/lib/settings/store";
import { keepRequestsOnThisMachine } from "@/lib/test-support/outside-requests";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";
import {
  BASEMAP_SWITCHES, BASEMAPS_CARD, builtInMeta, builtInRows, BUILT_IN_STYLES, hostOf, imageryState, LIBRARIES_LABELS, offeredWords,
  SATELLITE_ADDRESS_ROW, SATELLITE_CARD, SATELLITE_CREDIT_ROW, satelliteAddressWords, satelliteTestWords, SINGLE_MAP_ROW, STYLE_LIMITS,
  type LibraryStyleRead,
} from "./libraries-table";

/**
 * The Libraries table, held against the configuration read the server
 * answers: each basemap switch the read carries has its row and nothing
 * else is called one, the tile address is an address row and the credit
 * a text row of the read's length, the library's styles come through the
 * read in the shape the cards take, and the Add a style form's bounds are
 * the operation's. What the search and the card say of the tile address
 * is its scheme and host, never more.
 */

keepRequestsOnThisMachine();

const KEY = "SEEDED-KEY-0007-QUERY";
const TEMPLATE = `https://imagery.example/tiles/{z}/{x}/{y}.jpg?key=${KEY}`;

let fixture: ReturnType<typeof instanceSettingsFixture>;
beforeEach(() => { fixture = instanceSettingsFixture(); });
afterEach(() => fixture.close());
// Through the wire, as the page receives it.
const read = () => JSON.parse(JSON.stringify(readInstanceSettings(fixture.context, fixture.db)));
type Read = Record<string, { kind: string; editable: boolean; environment?: string; defaultValue: unknown;
  write?: { kind: string; maxLength?: number } }>;

describe("the Libraries table against the read", () => {
  it("gives every basemap switch the read carries a row, Reset's five, and calls nothing else one", () => {
    const settings: Read = read().settings;
    const switches = Object.keys(settings).filter(key => key.startsWith("basemaps."));
    expect([...BASEMAP_SWITCHES].sort()).toEqual([...switches].sort());
    for (const key of BASEMAP_SWITCHES) {
      expect(settings[key].kind, key).toBe("boolean");
      expect(settings[key].editable, key).toBe(true);
      expect(settings[key].defaultValue, key).toBe(true);
      expect(LIBRARIES_LABELS[key], key).toBeTruthy();
    }
    expect(BUILT_IN_STYLES.map(row => row.key)).toEqual([...BASEMAP_KEYS]);
    expect(BUILT_IN_STYLES.map(row => row.setting)).toEqual(BASEMAP_KEYS.map(key => OFFERED_SETTING[key]));
    expect(SINGLE_MAP_ROW.key).toBe("basemaps.singleMapStyles");
    const ids = [BASEMAPS_CARD.id, SATELLITE_CARD.id, ...BUILT_IN_STYLES.map(row => row.id), SINGLE_MAP_ROW.id, SATELLITE_ADDRESS_ROW.id, SATELLITE_CREDIT_ROW.id];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("takes the tile address as an address row and the credit as text of the read's length, each with its variable", () => {
    const settings: Read = read().settings;
    expect(settings[SATELLITE_ADDRESS_ROW.key]).toMatchObject({ kind: "address", editable: true, environment: "DEZFIL_SATELLITE_URL", write: { kind: "address" } });
    expect(settings[SATELLITE_CREDIT_ROW.key]).toMatchObject({ kind: "text", editable: true, environment: "DEZFIL_SATELLITE_ATTRIBUTION",
      write: { kind: "text", maxLength: SATELLITE_CREDIT_ROW.maxLength } });
    expect(LIBRARIES_LABELS[SATELLITE_ADDRESS_ROW.key]).toBe("Satellite tile address");
    expect(LIBRARIES_LABELS[SATELLITE_CREDIT_ROW.key]).toBe("Credit");
  });

  it("reads the library's styles, hidden ones included, in the shape the cards take", async () => {
    expect(read().basemapStyles).toEqual([]);
    const added = await addLibraryStyle(fixture.context, { name: "Harbor chart", url: "https://tiles.example/styles/harbor/style.json" }, fixture.db,
      { inspect: async () => ({ verdict: "valid", attribution: [] }) as never });
    const styles: LibraryStyleRead[] = read().basemapStyles;
    expect(styles).toEqual([{ id: added.id, name: "Harbor chart", url: "https://tiles.example/styles/harbor/style.json",
      attribution: [{ label: "tiles.example" }], offered: true, addedAt: expect.any(String) }]);
    expect(Object.keys(styles[0]).sort()).toEqual(["addedAt", "attribution", "id", "name", "offered", "url"]);
    expect(hostOf(styles[0].url)).toBe("tiles.example");
    expect(offeredWords(hostOf(styles[0].url), false)).toBe("tiles.example · Hidden");
  });

  it("bounds the Add a style form where the operation does", () => {
    const at = (name: number, address: number) => ({ name: "n".repeat(name), url: `https://tiles.example/${"a".repeat(address - 22)}` });
    expect(at(1, STYLE_LIMITS.address).url).toHaveLength(STYLE_LIMITS.address);
    expect(() => admitStyleInput(at(STYLE_LIMITS.name, STYLE_LIMITS.address))).not.toThrow();
    expect(() => admitStyleInput(at(STYLE_LIMITS.name + 1, 30))).toThrow(/name must be 1 to 60 characters/);
    expect(() => admitStyleInput(at(1, STYLE_LIMITS.address + 1))).toThrow(/url must be at most 2,048 characters/);
  });
});

describe("the imagery as the read reports it", () => {
  it("is not set up, then ready with Satellite among the built-in rows, its host under it and only its scheme and host said", () => {
    expect(imageryState(read().settings)).toBe("none");
    expect(builtInRows(read().settings).map(row => row.label)).toEqual(["Dark", "Light", "Streets"]);
    expect(satelliteAddressWords(read().settings)).toBe("Not set up");
    writeStoredSettings({ satelliteUrl: TEMPLATE, satelliteAttribution: "Imagery © Example" }, fixture.db);
    const settings = read().settings;
    expect(imageryState(settings)).toBe("ready");
    const rows = builtInRows(settings);
    expect(rows.map(row => row.label)).toEqual(["Dark", "Light", "Streets", "Satellite"]);
    expect(rows.map(row => builtInMeta(row, settings))).toEqual(["OpenFreeMap · built in", "OpenFreeMap · built in", "OpenFreeMap · built in", "imagery.example"]);
    expect(satelliteAddressWords(settings)).toBe("https://imagery.example");
    expect(JSON.stringify(read())).not.toContain(KEY);
    expect(settings.satelliteAttribution.value).toBe("Imagery © Example");
  });

  it("is set but unreadable where the address cannot be read, with no Satellite row, and says only Set", () => {
    vi.stubEnv("DEZFIL_SATELLITE_URL", "seed-malformed-address");
    const settings = read().settings;
    expect(settings.satelliteUrl).toMatchObject({ value: { set: true, unreadable: true }, source: "environment" });
    expect(imageryState(settings)).toBe("unreadable");
    expect(builtInRows(settings).map(row => row.label)).toEqual(["Dark", "Light", "Streets"]);
    expect(satelliteAddressWords(settings)).toBe("Set");
  });

  it("says the environment's tile address as its scheme and host", () => {
    vi.stubEnv("DEZFIL_SATELLITE_URL", TEMPLATE);
    const settings = read().settings;
    expect(settings.satelliteUrl).toMatchObject({ source: "environment", locked: true });
    expect(satelliteAddressWords(settings)).toBe("https://imagery.example");
    expect(imageryState(settings)).toBe("ready");
  });
});

describe("the satellite Test's line", () => {
  it("says a tile's time, a wrong answer and the shared reasons", () => {
    expect(satelliteTestWords({ service: "satellite", result: "passed", milliseconds: 1240 } as never)).toEqual({ passed: true, text: "A tile arrived in 1,240 ms" });
    expect(satelliteTestWords({ service: "satellite", result: "failed", reason: "unexpected_answer" } as never))
      .toEqual({ passed: false, text: "Answered, but not with a tile image." });
    expect(satelliteTestWords({ service: "satellite", result: "failed", reason: "status", status: 404 } as never))
      .toEqual({ passed: false, text: "Answered with status 404." });
  });
});
