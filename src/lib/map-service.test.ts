import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { createMap, updateMap, requireMap } from "./map-service";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
});

afterEach(async () => {
  closeMetadataDb();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe("map basemap choice (Auto is expressible)", () => {
  it("starts on Auto, takes an explicit choice, and returns to Auto via null", () => {
    const map = createMap("m");
    expect(map.basemap).toBeNull(); // new maps start on Auto

    updateMap(map.id, { basemap: "streets" });
    expect(requireMap(map.id).basemap).toBe("streets");

    // Explicit null clears the choice — "absent" must leave it untouched.
    updateMap(map.id, { name: "renamed" });
    expect(requireMap(map.id).basemap).toBe("streets");
    updateMap(map.id, { basemap: null });
    expect(requireMap(map.id).basemap).toBeNull();
  });

  it("accepts satellite like any style, with toggles preserved", () => {
    const map = createMap("m");
    // Toggles saved on a vector style survive a switch to imagery — the
    // canvas skips them there, but nothing is erased.
    updateMap(map.id, { basemapLayers: { land: false } });
    updateMap(map.id, { basemap: "satellite" });
    const after = requireMap(map.id);
    expect(after.basemap).toBe("satellite");
    expect(after.basemapLayers).toEqual({ land: false });
  });
});

describe("basemap layer toggles", () => {
  it("hides groups, keeps only hidden entries, and clears via null", () => {
    const map = createMap("m");
    expect(map.basemapLayers).toBeNull(); // earlier semantics: all visible

    // Visible entries normalize away — only hidden groups are stored.
    updateMap(map.id, {
      basemapLayers: { labels: false, roads: false, water: true },
    });
    expect(requireMap(map.id).basemapLayers).toEqual({
      labels: false,
      roads: false,
    });

    // Unrelated updates leave the toggles untouched.
    updateMap(map.id, { name: "renamed" });
    expect(requireMap(map.id).basemapLayers).toEqual({
      labels: false,
      roads: false,
    });

    // Everything visible is the same as null.
    updateMap(map.id, { basemapLayers: { labels: true } });
    expect(requireMap(map.id).basemapLayers).toBeNull();

    updateMap(map.id, { basemapLayers: { buildings: false } });
    updateMap(map.id, { basemapLayers: null });
    expect(requireMap(map.id).basemapLayers).toBeNull();
  });

  it("rejects unknown groups and non-boolean values with no partial write", () => {
    const map = createMap("m");
    updateMap(map.id, { basemapLayers: { labels: false } });

    const attempts: unknown[] = [
      { threeDee: false }, // unknown group
      { labels: "off" }, // non-boolean
      ["labels"], // not an object
      "labels", // not an object
    ];
    for (const basemapLayers of attempts) {
      expect(() => updateMap(map.id, { basemapLayers })).toThrowError(
        expect.objectContaining({ code: "invalid_request" }),
      );
      expect(requireMap(map.id).basemapLayers).toEqual({ labels: false });
    }
  });
});

describe("legend corner", () => {
  it("moves the legend, keeps it across unrelated updates, resets via null", () => {
    const map = createMap("m");
    expect(map.legendCorner).toBeNull(); // earlier semantics: bottom-left

    updateMap(map.id, { legendCorner: "top-right" });
    expect(requireMap(map.id).legendCorner).toBe("top-right");

    updateMap(map.id, { name: "renamed" });
    expect(requireMap(map.id).legendCorner).toBe("top-right");

    updateMap(map.id, { legendCorner: null });
    expect(requireMap(map.id).legendCorner).toBeNull();
  });

  it("rejects unknown corners with no partial write", () => {
    const map = createMap("m");
    updateMap(map.id, { legendCorner: "top-left" });
    for (const legendCorner of ["center", "top", 3, {}]) {
      expect(() =>
        updateMap(map.id, { legendCorner, name: "should not land" }),
      ).toThrowError(expect.objectContaining({ code: "invalid_request" }));
      expect(requireMap(map.id).legendCorner).toBe("top-left");
      expect(requireMap(map.id).name).toBe("m");
    }
  });
});

describe("map note (retired into note widgets)", () => {
  it("keeps the legacy note column null and rejects nothing silently", () => {
    const map = createMap("m");
    // No box anywhere: fresh maps never carry the note; notes are
    // widgets now and travel through `widgets`.
    expect(map.note).toBeNull();
    const withNote = updateMap(map.id, {
      widgets: [
        {
          id: "n1",
          type: "note",
          layerId: null,
          title: "Sources",
          field: null,
          agg: "count",
          aggField: null,
          unit: null,
          note: "Data © **OpenStreetMap**",
          format: null,
          visible: true,
        },
      ],
    });
    expect(withNote.note).toBeNull();
    expect(withNote.widgets[0]).toMatchObject({
      type: "note",
      layerId: null,
      note: "Data © **OpenStreetMap**",
    });
    // A note without a body (or with a layer) is rejected whole.
    for (const bad of [
      { note: null },
      { layerId: "l1" },
      { note: "x".repeat(2001) },
    ]) {
      expect(() =>
        updateMap(map.id, {
          widgets: [{ ...withNote.widgets[0], ...bad }],
        }),
      ).toThrowError(expect.objectContaining({ code: "invalid_request" }));
    }
  });
});
