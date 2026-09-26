import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { Database } from "better-sqlite3";
import { open } from "./db";
import {
  customPaletteProblem,
  createCustomPalette,
  listCustomPalettes,
  getCustomPalette,
  deleteCustomPalette,
} from "./palettes";

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

const STOPS = [
  { color: "#112233", position: 0 },
  { color: "#445566", position: 0.4 },
  { color: "#FFEEDD", position: 1 },
];

describe("custom palettes", () => {
  it("validates payloads with explanations", () => {
    expect(customPaletteProblem({ label: "Brand", stops: STOPS })).toBeNull();
    expect(customPaletteProblem(null)).toMatch(/object/);
    expect(customPaletteProblem({ label: "", stops: STOPS })).toMatch(/label/);
    expect(
      customPaletteProblem({ label: "x", stops: [STOPS[0]] }),
    ).toMatch(/stops/);
    expect(
      customPaletteProblem({
        label: "x",
        stops: [
          { color: "red", position: 0 },
          { color: "#000000", position: 1 },
        ],
      }),
    ).toMatch(/hex/);
    expect(
      customPaletteProblem({
        label: "x",
        stops: [
          { color: "#000000", position: 0.9 },
          { color: "#ffffff", position: 0.1 },
        ],
      }),
    ).toMatch(/decrease/);
  });

  it("creates, lists, fetches, and deletes a palette", () => {
    const saved = createCustomPalette({ label: " Brand ", stops: STOPS }, db);
    expect(saved.name).toMatch(/^custom-[0-9a-f]{8}$/);
    expect(saved.label).toBe("Brand");
    // Stored lowercase, sorted by position.
    expect(saved.stops[2].color).toBe("#ffeedd");
    expect(listCustomPalettes(db)).toHaveLength(1);
    expect(getCustomPalette(saved.name, db)?.label).toBe("Brand");
    expect(deleteCustomPalette(saved.name, db)).toBe(true);
    expect(deleteCustomPalette(saved.name, db)).toBe(false);
    expect(listCustomPalettes(db)).toHaveLength(0);
  });

  it("keeps creation order in the listing", () => {
    createCustomPalette({ label: "A", stops: STOPS }, db);
    createCustomPalette({ label: "B", stops: STOPS }, db);
    expect(listCustomPalettes(db).map((p) => p.label)).toEqual(["A", "B"]);
  });
});
