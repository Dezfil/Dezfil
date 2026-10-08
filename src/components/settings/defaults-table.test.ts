import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isInstanceDefault } from "@/lib/settings/instance-defaults";
import { readInstanceSettings } from "@/lib/settings/read";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";
import { CHOICE_WORDS, choiceWords, DEFAULTS_LABELS, DEFAULTS_TABS, defaultsFields, defaultsRows } from "./defaults-table";

/**
 * The defaults' label table, held against the configuration read the
 * server answers: every default for new things (a setting every signed-in
 * account reads, in the defaults' five groups) has a row under its label
 * on one of the three tabs, every row names a setting the read carries, a
 * choice's words cover exactly the values the read offers, and a number's
 * unit and step agree with the read's.
 */

interface ReadSetting {
  kind: string;
  readBy: string;
  editable: boolean;
  unit?: string;
  write?: { kind: string; values?: string[]; min?: number; max?: number };
}

let fixture: ReturnType<typeof instanceSettingsFixture>;
beforeEach(() => { fixture = instanceSettingsFixture(); });
afterEach(() => fixture.close());
// Through the wire, as the page receives it.
const read = (): Record<string, ReadSetting> => JSON.parse(JSON.stringify(readInstanceSettings(fixture.context, fixture.db))).settings;

describe("the defaults' table against the read", () => {
  it("gives every default a row on one of the three tabs, and names nothing the read lacks", () => {
    const settings = read();
    const defaults = Object.entries(settings).filter(([key, setting]) => isInstanceDefault({ key, readBy: setting.readBy })).map(([key]) => key);
    const drawn = defaultsFields().map(field => field.key);
    expect(new Set(drawn).size).toBe(drawn.length);
    expect([...drawn].sort()).toEqual([...defaults].sort());
    expect(defaults).toHaveLength(18);
    for (const key of drawn) expect(settings[key].editable).toBe(true);
  });

  it("words every value a choice offers and nothing else, in the read's order", () => {
    const settings = read();
    const choices = defaultsFields().filter(field => settings[field.key].write?.kind === "choice");
    expect(choices.map(field => field.key).sort()).toEqual(Object.keys(CHOICE_WORDS).sort());
    for (const field of choices) {
      const values = settings[field.key].write!.values!;
      expect(Object.keys(CHOICE_WORDS[field.key as keyof typeof CHOICE_WORDS])).toEqual(values);
      for (const value of values) expect(choiceWords(field.key, value)).toMatch(/\S/);
      // A choice the read gives a unit is worded with it, as the page shows it.
      const unit = settings[field.key].unit;
      if (unit) for (const value of values) expect(choiceWords(field.key, value)).toBe(`${value} ${unit}`);
    }
  });

  it("writes each number's unit as the read gives it, steps a whole number by one and a decimal finer", () => {
    const settings = read();
    for (const field of defaultsFields()) {
      const setting = settings[field.key], kind = setting.write!.kind;
      if (kind === "integer") expect(field.step).toBe(1);
      else if (kind === "decimal") expect(field.step === "any" || (typeof field.step === "number" && !Number.isInteger(field.step))).toBe(true);
      else expect(field.step).toBeUndefined();
      expect(field.unit).toBe(kind === "integer" || kind === "decimal" ? setting.unit : undefined);
    }
  });
});

describe("the three tabs' cards and rows", () => {
  it("lays out each tab's cards and rows in the order and under the labels the page shows, and no other", () => {
    const layout = Object.fromEntries(Object.entries(DEFAULTS_TABS).map(([tab, cards]) =>
      [tab, cards.map(card => [card.title, card.rows.map(row => row.label)])]));
    expect(layout).toEqual({
      maps: [
        ["New maps", ["Basemap", "Starting view"]],
        ["Legend", ["Legend corner"]],
        ["New layers", ["Color cycle", "Opacity", "Line width", "Point radius"]],
      ],
      workflows: [
        ["Workflow canvas", ["Canvas opens", "Minimap", "Results band"]],
        ["SQL console", ["Text size", "Line wrap"]],
      ],
      publishing: [
        ["Image export", ["Starting width", "Starting shape"]],
      ],
    });
    for (const cards of Object.values(DEFAULTS_TABS)) {
      const ids = cards.flatMap(card => [card.id, ...card.rows.map(row => row.id)]);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("names each number where a row draws several, and shows every default under its own label", () => {
    const row = (id: string) => defaultsRows().find(entry => entry.id === id)!;
    expect(row("set-starting-view").fields.map(field => [field.key, field.label])).toEqual([
      ["newMap.latitude", "Latitude"], ["newMap.longitude", "Longitude"], ["newMap.zoom", "Zoom"],
    ]);
    expect(row("set-opacity").fields.map(field => [field.key, field.label, field.unit])).toEqual([
      ["newLayer.pointOpacity", "Points", "%"], ["newLayer.lineOpacity", "Lines", "%"], ["newLayer.areaOpacity", "Areas", "%"],
    ]);
    for (const entry of defaultsRows()) if (entry.fields.length === 1) expect(entry.fields[0].label).toBeUndefined();
    expect(DEFAULTS_LABELS).toEqual({
      "newMap.basemap": "Basemap", "newMap.latitude": "Latitude", "newMap.longitude": "Longitude", "newMap.zoom": "Zoom",
      "newMap.legendCorner": "Legend corner", "newLayer.colorCycle": "Color cycle", "newLayer.pointOpacity": "Points",
      "newLayer.lineOpacity": "Lines", "newLayer.areaOpacity": "Areas", "newLayer.lineWidth": "Line width",
      "newLayer.pointRadius": "Point radius", "canvas.opens": "Canvas opens", "canvas.minimap": "Minimap",
      "canvas.resultsBand": "Results band", "sqlConsole.textSize": "Text size", "sqlConsole.lineWrap": "Line wrap",
      "imageExport.width": "Starting width", "imageExport.shape": "Starting shape",
    });
  });

  it("words each choice as the page shows it, and a value it does not word as itself", () => {
    expect(choiceWords("newMap.basemap", "streets")).toBe("Streets");
    expect(choiceWords("newMap.legendCorner", "bottom-left")).toBe("Bottom left");
    expect(choiceWords("newLayer.colorCycle", "uber_viz_qualitative")).toBe("Viz Qualitative");
    expect(choiceWords("canvas.opens", "full")).toBe("Full screen");
    expect(choiceWords("canvas.minimap", "auto")).toBe("Automatic");
    expect(choiceWords("sqlConsole.textSize", "16")).toBe("16 px");
    expect(choiceWords("imageExport.width", "1920")).toBe("1920 px");
    expect(choiceWords("imageExport.shape", "16:9")).toBe("16:9");
    expect(choiceWords("canvas.minimap", "sometimes")).toBe("sometimes");
  });
});
