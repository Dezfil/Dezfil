import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readInstanceSettings } from "@/lib/settings/read";
import { TIMEOUT_RELATIONSHIP } from "@/lib/settings/relationships";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";
import { capacityText, inLabels, LIMITS_CARDS, LIMITS_LABELS, limitsSettingRows } from "./limits-table";

/**
 * The Limits tab's label table, held against the configuration read the
 * server answers: every number an admin may change has a row under its
 * label, every row names a setting the read carries, and the two fixed
 * rows are the ones the read reports as the server's to decide.
 */

let fixture: ReturnType<typeof instanceSettingsFixture>;
beforeEach(() => { fixture = instanceSettingsFixture(); });
afterEach(() => fixture.close());
// Through the wire, as the page receives it.
const read = () => JSON.parse(JSON.stringify(readInstanceSettings(fixture.context, fixture.db)));

describe("the Limits label table against the read", () => {
  it("gives every number an admin may change a row, and names nothing the read lacks", () => {
    const settings: Record<string, { kind: string; editable: boolean; scope: string }> = read().settings;
    const editable = Object.entries(settings).filter(([, setting]) => setting.kind === "number" && setting.editable).map(([key]) => key);
    const drawn = limitsSettingRows().map(row => row.key);
    expect(new Set(drawn).size).toBe(drawn.length);
    expect(drawn.filter(key => settings[key]?.editable).sort()).toEqual(editable.sort());
    expect(editable).toHaveLength(14);
    for (const key of drawn) expect(settings[key]?.kind).toBe("number");
  });

  it("draws the feature cap as the server's, with its variable, and the largest image from the read's own fact", () => {
    const answer = read();
    const fixed = limitsSettingRows().filter(row => !answer.settings[row.key].editable);
    expect(fixed.map(row => [row.key, row.label])).toEqual([["renderCapFeatures", "Features drawn per layer"]]);
    expect(answer.settings.renderCapFeatures.environment).toBe("DEZFIL_RENDER_CAP_FEATURES");
    const image = LIMITS_CARDS.flatMap(card => card.rows).filter(row => row.kind === "image");
    expect(image.map(row => row.label)).toEqual(["Largest image"]);
    expect(typeof answer.maxImageDimension).toBe("number");
  });

  it("lays out the five cards in the order and under the labels the page shows", () => {
    expect(LIMITS_CARDS.map(card => [card.title, card.rows.map(row => row.label)])).toEqual([
      ["Imports", ["Largest upload", "Largest link import", "Link import time limit", "OpenStreetMap area", "Overture area"]],
      ["Queries", ["Query time limit", "Rows shown in results", "Features drawn per layer"]],
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
