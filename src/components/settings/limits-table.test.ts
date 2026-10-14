import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readInstanceSettings } from "@/lib/settings/read";
import { TIMEOUT_RELATIONSHIP } from "@/lib/settings/relationships";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";
import { capacityText, inLabels, LIMITS_CARDS, LIMITS_LABELS, LIMITS_UNITS, limitsSettingRows, serviceSetUp, shownUnit, withShownUnit } from "./limits-table";

/**
 * The Limits tab's label table, held against the configuration read the
 * server answers: every number an admin may change has a row under its
 * label, every row names a setting the read carries, and the two fixed
 * rows are the ones the read reports as the server's to decide.
 */

const SERVICE_NUMBERS = ["geocodePaceMs", "geocodeRequestTimeoutS", "geocodeMatchCacheHours", "isochronePaceMs",
  "isochroneRequestTimeoutS", "isochroneCacheHours", "overpassTimeoutS", "overpassCacheHours"];

let fixture: ReturnType<typeof instanceSettingsFixture>;
beforeEach(() => { fixture = instanceSettingsFixture(); });
afterEach(() => fixture.close());
// Through the wire, as the page receives it.
const read = () => JSON.parse(JSON.stringify(readInstanceSettings(fixture.context, fixture.db)));

describe("the Limits label table against the read", () => {
  it("gives every number an admin may change a row, and names nothing the read lacks", () => {
    const settings: Record<string, { kind: string; editable: boolean; scope: string; readBy: string; environment?: string }> = read().settings;
    // The limits are the admin's to read, and a variable can set each; the
    // numbers every signed-in account reads are what new things start with,
    // and the sign-in numbers no variable sets: both are drawn on their own tabs.
    // The services' numbers are drawn with their services, beside their addresses.
    const editable = Object.entries(settings).filter(([key, setting]) => setting.kind === "number" && setting.editable && setting.readBy === "admin" && setting.environment
      && !SERVICE_NUMBERS.includes(key)).map(([key]) => key);
    const drawn = limitsSettingRows().map(row => row.key);
    expect(new Set(drawn).size).toBe(drawn.length);
    expect(drawn.filter(key => settings[key]?.editable).sort()).toEqual(editable.sort());
    expect(editable).toHaveLength(15);
    for (const key of drawn) expect(settings[key]?.kind).toBe("number");
  });

  it("ties each capacity to the address of the service its tool calls, which the read reports as set or not", () => {
    const answer = read();
    const capacities = LIMITS_CARDS.flatMap(card => card.rows).flatMap(row => row.kind === "capacity" ? [row] : []);
    expect(capacities.map(row => [row.of, row.service])).toEqual([["geocode", "geocoderUrl"], ["travel", "isochroneUrl"]]);
    for (const row of capacities) {
      expect(answer.settings[row.service].kind).toBe("address");
      expect(typeof serviceSetUp(answer.settings, row.service)).toBe("boolean");
    }
    expect(serviceSetUp({ geocoderUrl: { value: { set: true, origin: "https://geocoder.example" } } }, "geocoderUrl")).toBe(true);
    expect(serviceSetUp({ geocoderUrl: { value: { set: false } } }, "geocoderUrl")).toBe(false);
    expect(serviceSetUp({}, "geocoderUrl")).toBeNull();
  });

  it("draws the feature cap as the server's, with its variable, and the largest image from the read's own fact", () => {
    const answer = read();
    const fixed = limitsSettingRows().filter(row => !answer.settings[row.key].editable);
    expect(fixed.map(row => [row.key, row.label])).toEqual([["renderCapFeatures", "Features drawn per layer"], ["renderCapBytes", "Bytes drawn per layer"]]);
    expect(answer.settings.renderCapFeatures.environment).toBe("DEZFIL_RENDER_CAP_FEATURES");
    const image = LIMITS_CARDS.flatMap(card => card.rows).filter(row => row.kind === "image");
    expect(image.map(row => row.label)).toEqual(["Largest image"]);
    expect(typeof answer.maxImageDimension).toBe("number");
  });

  it("lays out the five cards in the order and under the labels the page shows", () => {
    expect(LIMITS_CARDS.map(card => [card.title, card.rows.map(row => row.label)])).toEqual([
      ["Imports", ["Largest upload", "Data processing time limit", "Largest link import", "Link import time limit", "OpenStreetMap area", "Overture area"]],
      ["Queries", ["Query time limit", "Rows shown in results", "Features drawn per layer", "Bytes drawn per layer"]],
      ["Tools", ["Tools running at once", "Tools waiting", "Time limit per tool run", "Geocode addresses", "Travel-time area"]],
      ["Image export", ["Largest image", "Images at once", "Time limit per image"]],
      ["Public requests", ["Requests per visitor", "Tile requests per visitor"]],
    ]);
    expect(LIMITS_LABELS).toMatchObject({
      uploadMaxMb: "Largest upload", operationConcurrency: "Tools running at once", operationQueueMax: "Tools waiting",
      operationTimeoutS: "Time limit per tool run", exportRenderConcurrency: "Images at once", publicRateLimit: "Requests per visitor",
    });
    const ids = LIMITS_CARDS.flatMap(card => [card.id, ...card.rows.map(row => row.id)]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("the units the page shows", () => {
  it("writes a count with no unit, a rate window as every 10 seconds, the largest image per side, and the read's unit for the rest", () => {
    const settings: Record<string, { unit?: string }> = read().settings;
    const shown = LIMITS_CARDS.map(card => [card.title, card.rows.flatMap(row =>
      row.kind === "setting" ? [shownUnit(row.key, settings[row.key].unit)] : row.kind === "image" ? [row.unit] : [])]);
    expect(shown).toEqual([
      ["Imports", ["MB", "seconds", "MB", "seconds", "km²", "km²"]],
      ["Queries", ["seconds", "rows", "features", "bytes"]],
      ["Tools", ["", "", "seconds"]],
      ["Image export", ["px per side", "", "seconds"]],
      ["Public requests", ["every 10 seconds", "every 10 seconds"]],
    ]);
  });

  it("names a unit only where the read's is not the page's, and only for a row Limits draws", () => {
    const settings: Record<string, { unit?: string }> = read().settings;
    const drawn = new Set(limitsSettingRows().map(row => row.key));
    expect(Object.keys(LIMITS_UNITS).sort()).toEqual(["exportRenderConcurrency", "operationConcurrency", "operationQueueMax", "publicRateLimit", "publicTileRateLimit"]);
    for (const [key, unit] of Object.entries(LIMITS_UNITS)) {
      expect(drawn.has(key)).toBe(true);
      expect(settings[key].unit).not.toBe(unit);
    }
  });

  it("writes a value with the unit the page shows, grouped, and a count bare", () => {
    expect(withShownUnit("operationConcurrency", 1, "runs")).toBe("1");
    expect(withShownUnit("exportRenderConcurrency", 2, "renders")).toBe("2");
    expect(withShownUnit("publicRateLimit", 60, "per 10 seconds")).toBe("60 every 10 seconds");
    expect(withShownUnit("uploadMaxMb", 5120, "MB")).toBe("5,120 MB");
    // A setting Limits does not draw keeps the read's own unit.
    expect(withShownUnit("operationHistoryPerSubject", 20, "runs")).toBe("20 runs");
  });
});

describe("the words a refusal is shown in", () => {
  it("names a row by its label, never by the key the API knows it by", () => {
    const shown = inLabels(TIMEOUT_RELATIONSHIP, LIMITS_LABELS);
    expect(shown).toBe("Query time limit must be less than Time limit per tool run. The effective timeout limits do not satisfy this relationship.");
    expect(inLabels("remoteMaxMb: Locked by DEZFIL_REMOTE_MAX_MB.", LIMITS_LABELS)).toBe("Largest link import: Locked by DEZFIL_REMOTE_MAX_MB.");
    expect(inLabels("Enter a number from 5 to 600.", LIMITS_LABELS)).toBe("Enter a number from 5 to 600.");
  });
});

describe("a capacity's words", () => {
  it("says how many a run takes, and that travel time may take none", () => {
    expect(capacityText("geocode", 27)).toBe("Up to 27 addresses per run");
    expect(capacityText("geocode", 1)).toBe("Up to 1 address per run");
    expect(capacityText("travel", 1250)).toBe("Up to 1,250 origins per run");
    expect(capacityText("travel", 1)).toBe("Up to 1 origin per run");
    expect(capacityText("travel", 0)).toBe("None at these limits");
  });
});
