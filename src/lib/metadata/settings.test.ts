import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { Database } from "better-sqlite3";
import { open } from "./db";
import {
  getSetting,
  setSetting,
  displayName,
  setDisplayName,
  viewPrefs,
  mergeViewPrefs,
  DEFAULT_DISPLAY_NAME,
} from "./settings";

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

describe("workspace settings", () => {
  it("returns null for unset keys", () => {
    expect(getSetting("nope", db)).toBeNull();
  });

  it("stores and overwrites values", () => {
    setSetting("k", "one", db);
    expect(getSetting("k", db)).toBe("one");
    setSetting("k", "two", db);
    expect(getSetting("k", db)).toBe("two");
  });

  it("display name falls back to the default until set", () => {
    expect(displayName(db)).toBe(DEFAULT_DISPLAY_NAME);
    setDisplayName("Ada Lovelace", db);
    expect(displayName(db)).toBe("Ada Lovelace");
  });

  it("view prefs start empty and merge per screen", () => {
    expect(viewPrefs(db)).toEqual({});
    mergeViewPrefs({ maps: { view: "list" } }, db);
    mergeViewPrefs({ data: { sort: "rows" } }, db);
    mergeViewPrefs({ maps: { sort: "name" } }, db);
    mergeViewPrefs({ workflows: { view: "list" } }, db);
    mergeViewPrefs({ workflows: { sort: "created" } }, db);
    expect(viewPrefs(db)).toEqual({
      maps: { view: "list", sort: "name" },
      data: { sort: "rows" },
      workflows: { view: "list", sort: "created" },
    });
  });

  it("remembers the Projects list too, beside the three siblings", () => {
    mergeViewPrefs({ maps: { view: "list" } }, db);
    mergeViewPrefs({ projects: { view: "list" } }, db);
    mergeViewPrefs({ projects: { sort: "largest" } }, db);
    expect(viewPrefs(db).projects).toEqual({ view: "list", sort: "largest" });
    expect(viewPrefs(db).maps).toEqual({ view: "list" });
  });
});
