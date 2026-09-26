// The status bar's priority choice is a pure function — the largest
// priority-prefix of present items that fits the capacity, coords
// surviving last, pitch dropping first, never a skipped item.
import { describe, expect, it } from "vitest";
import { pickStatusItems, type StatusKey } from "./use-status-priority";

const ALL: StatusKey[] = ["records", "coords", "zoom", "pitch", "bbox"];
const GAP = 14;

const widths = (w: Partial<Record<StatusKey, number>>) =>
  new Map(Object.entries(w) as [StatusKey, number][]);

const EVEN = widths({
  records: 80,
  coords: 120,
  zoom: 60,
  pitch: 60,
  bbox: 200,
});

describe("pickStatusItems", () => {
  it("keeps everything when everything fits", () => {
    // 120+60+80+200+60 + 4 gaps = 576
    expect(pickStatusItems(ALL, EVEN, GAP, 576)).toEqual([
      "coords",
      "zoom",
      "records",
      "bbox",
      "pitch",
    ]);
  });

  it("drops in the ruled order as capacity shrinks: pitch, bbox, records, zoom", () => {
    // One px under the full fit: pitch is the first to go.
    expect(pickStatusItems(ALL, EVEN, GAP, 575)).toEqual([
      "coords",
      "zoom",
      "records",
      "bbox",
    ]);
    // Under coords+zoom+records+bbox (502): bbox goes too.
    expect(pickStatusItems(ALL, EVEN, GAP, 501)).toEqual([
      "coords",
      "zoom",
      "records",
    ]);
    // Under coords+zoom+records (288): records goes.
    expect(pickStatusItems(ALL, EVEN, GAP, 287)).toEqual(["coords", "zoom"]);
    // Under coords+zoom (194): zoom goes.
    expect(pickStatusItems(ALL, EVEN, GAP, 193)).toEqual(["coords"]);
  });

  it("returns nothing when even coords cannot fit", () => {
    expect(pickStatusItems(ALL, EVEN, GAP, 119)).toEqual([]);
    expect(pickStatusItems(ALL, EVEN, GAP, 0)).toEqual([]);
  });

  it("skips absent items without spending their priority slot", () => {
    // No records, no pitch (the everyday map): bbox rides right behind zoom.
    const present: StatusKey[] = ["coords", "zoom", "bbox"];
    expect(pickStatusItems(present, EVEN, GAP, 408)).toEqual([
      "coords",
      "zoom",
      "bbox",
    ]);
    expect(pickStatusItems(present, EVEN, GAP, 407)).toEqual([
      "coords",
      "zoom",
    ]);
  });

  it("counts gaps between survivors, not per item", () => {
    // coords+zoom exactly with one gap: 120+14+60 = 194.
    expect(pickStatusItems(ALL, EVEN, GAP, 194)).toEqual(["coords", "zoom"]);
  });

  it("ends the prefix at a missing measurement rather than skipping past it", () => {
    const partial = widths({ coords: 120, zoom: 60, bbox: 200 });
    // records present but unmeasured: the prefix stops before it, and
    // bbox is not pulled forward past the gap.
    expect(pickStatusItems(ALL, partial, GAP, 10_000)).toEqual([
      "coords",
      "zoom",
    ]);
  });
});
