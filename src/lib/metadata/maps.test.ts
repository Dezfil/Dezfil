import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { Database } from "better-sqlite3";
import { open } from "./db";
import { createProject, fileMap } from "./projects";
import {
  getMap,
  getPublishedSnapshot,
  getPublishedTheme,
  getViewerControls,
  insertMap,
  listMaps,
  normalizeViewerControls,
  setPublishedTheme,
  setViewerControls,
  type MapRecord,
  type ViewerControls,
} from "./maps";

let dir: string;
let db: Database;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  db = open(path.join(dir, "metadata.sqlite"));
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

function sample(id: string, createdAt: string): MapRecord {
  return {
    id,
    name: `map ${id}`,
    viewport: { lng: 0, lat: 20, zoom: 1.4 },
    basemap: null,
    customBasemap: null,
    basemapLayers: null,
    note: null,
    legendCorner: null,
    legendOrder: null,
    timeline: null,
    widgets: [],
    widgetsPublished: true,
    publishToken: null,
    publishedAt: null,
    createdAt,
    updatedAt: createdAt,
  };
}

describe("maps listing", () => {
  it("lists most recently created first", () => {
    insertMap(testAccountScope(db), sample("old", "2026-07-01T00:00:00Z"), db);
    insertMap(testAccountScope(db), sample("new", "2026-07-20T00:00:00Z"), db);
    insertMap(testAccountScope(db), sample("mid", "2026-07-10T00:00:00Z"), db);
    expect(listMaps(db).map((m) => m.id)).toEqual(["new", "mid", "old"]);
  });
});

describe("published theme metadata", () => {
  it("round-trips and clears; a fresh map holds none", () => {
    insertMap(testAccountScope(db), sample("m1", "2026-08-01T00:00:00Z"), db);
    expect(getPublishedTheme("m1", db)).toBeNull();
    setPublishedTheme("m1", "light", db);
    expect(getPublishedTheme("m1", db)).toBe("light");
    setPublishedTheme("m1", null, db);
    expect(getPublishedTheme("m1", db)).toBeNull();
  });

  it("stays off the map record — ordinary map reads cannot see it", () => {
    insertMap(testAccountScope(db), sample("m1", "2026-08-01T00:00:00Z"), db);
    setPublishedTheme("m1", "light", db);
    const record = getMap("m1", db);
    expect(record).not.toBeNull();
    expect("publishedTheme" in record!).toBe(false);
    expect(JSON.stringify(record)).not.toContain("light");
  });

  it("rides the published snapshot and moves its revision", () => {
    const map = sample("m1", "2026-08-01T00:00:00Z");
    map.publishToken = "t".repeat(22);
    map.publishedAt = "2026-08-01T00:00:00Z";
    insertMap(testAccountScope(db), map, db);
    const before = getPublishedSnapshot(map.publishToken!, db)!;
    expect(before.publishedTheme).toBeNull();
    setPublishedTheme("m1", "light", db);
    const after = getPublishedSnapshot(map.publishToken!, db)!;
    expect(after.publishedTheme).toBe("light");
    expect(after.revision).not.toBe(before.revision);
  });
  it("never observes project membership: filing, moving and unfiling leave the revision and payload byte-identical", () => {
    const map = sample("m2", "2026-08-02T00:00:00Z");
    map.publishToken = "u".repeat(22);
    map.publishedAt = "2026-08-02T00:00:00Z";
    insertMap(testAccountScope(db), map, db);
    const a = createProject(testAccountScope(db), { name: "A" }, db);
    const b = createProject(testAccountScope(db), { name: "B" }, db);
    const before = getPublishedSnapshot(map.publishToken!, db)!;
    fileMap("m2", a.id, db);
    fileMap("m2", b.id, db);
    fileMap("m2", null, db);
    fileMap("m2", a.id, db);
    const after = getPublishedSnapshot(map.publishToken!, db)!;
    expect(after.revision).toBe(before.revision);
    expect(JSON.stringify(after.map)).toBe(JSON.stringify(before.map));
  });
});

describe("viewer controls metadata", () => {
  const SOME: ViewerControls = {
    tilt: false,
    fit: true,
    theme: false,
    basemap: true,
    coords: true,
  };

  it("round-trips and clears; a fresh map holds none", () => {
    insertMap(testAccountScope(db), sample("m1", "2026-08-01T00:00:00Z"), db);
    expect(getViewerControls("m1", db)).toBeNull();
    setViewerControls("m1", SOME, db);
    expect(getViewerControls("m1", db)).toEqual(SOME);
    setViewerControls("m1", null, db);
    expect(getViewerControls("m1", db)).toBeNull();
  });

  it("stays off the map record — ordinary map reads cannot see it", () => {
    insertMap(testAccountScope(db), sample("m1", "2026-08-01T00:00:00Z"), db);
    setViewerControls("m1", SOME, db);
    const record = getMap("m1", db);
    expect(record).not.toBeNull();
    expect("viewerControls" in record!).toBe(false);
    expect(JSON.stringify(record)).not.toContain("tilt");
  });

  it("rides the published snapshot and moves its revision on its own", () => {
    const map = sample("m1", "2026-08-01T00:00:00Z");
    map.publishToken = "t".repeat(22);
    map.publishedAt = "2026-08-01T00:00:00Z";
    insertMap(testAccountScope(db), map, db);
    const before = getPublishedSnapshot(map.publishToken!, db)!;
    expect(before.viewerControls).toBeNull();
    // Seed the column directly, leaving updated_at exactly where it was.
    // Going through the writer would bump the timestamp, and the timestamp
    // is inside the revision by way of the map record — so the assertion
    // would pass whether or not the column itself participates. This is
    // the only shape that actually tests participation.
    db.prepare(`UPDATE maps SET viewer_controls = ? WHERE id = ?`).run(
      JSON.stringify(SOME),
      "m1",
    );
    const after = getPublishedSnapshot(map.publishToken!, db)!;
    expect(after.map.updatedAt).toBe(before.map.updatedAt);
    expect(after.viewerControls).toEqual(SOME);
    expect(after.revision).not.toBe(before.revision);
  });

  it("normalizes: absent reads all-on, a stated set fills omissions on", () => {
    expect(normalizeViewerControls(null)).toEqual({
      tilt: true,
      fit: true,
      theme: true,
      basemap: true,
      coords: true,
    });
    expect(normalizeViewerControls({ tilt: false })).toEqual({
      tilt: false,
      fit: true,
      theme: true,
      basemap: true,
      coords: true,
    });
    // The member reads like the four before it — an earlier publication
    // opens with the readout on, no migration.
    expect(normalizeViewerControls({ coords: false }).coords).toBe(false);
  });

  it("degrades unreadable stored text to none rather than throwing", () => {
    insertMap(testAccountScope(db), sample("m1", "2026-08-01T00:00:00Z"), db);
    db.prepare(`UPDATE maps SET viewer_controls = ? WHERE id = ?`).run(
      "{not json",
      "m1",
    );
    expect(getViewerControls("m1", db)).toBeNull();
  });
});
