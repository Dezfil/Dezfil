import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { withConnection } from "@/lib/duckdb";
import { importOverture, countOverture, countOvertureLevels } from "./import";
import {
  countryDivisionIndex,
  aggregateLevels,
  listDivisionCountries,
  searchIndex,
} from "./divisions";

/**
 * Live integration against the public Overture bucket (acceptance
 * examples 1–4). Opt-in, network-heavy:
 *
 *   DEZFIL_TEST_OVERTURE=1 vitest run overture.live
 *
 * The release is pinned; releases are immutable, so counts are exact.
 */

const live = describe.skipIf(process.env.DEZFIL_TEST_OVERTURE !== "1");
const RELEASE = "2026-06-17.0";
const MINUTES = 60_000;

// A small rectangle around Frankfurt — the historical failure case whose
// bbox-overlap filter imported world-spanning countries.
const FRANKFURT: [number, number, number, number] = [8.45, 49.95, 8.85, 50.25];

let dir: string;

live("overture live integration", () => {
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "dezfil-ovt-"));
    process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  });

  afterAll(async () => {
    closeMetadataDb();
    delete process.env.DEZFIL_DATA_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it(
    "imports exactly the 16 states of Germany from a country scope",
    { timeout: 5 * MINUTES },
    async () => {
      const table = await importOverture(testAccountScope(), {
        theme: "divisions",
        scope: { type: "country", code: "DE", label: "Germany" },
        level: "region",
        release: RELEASE,
        name: "de_states",
      });
      expect(table.rowCount).toBe(16);
      expect(table.sourceParams).toMatchObject({
        theme: "divisions",
        level: "region",
        scope: { type: "country", code: "DE" },
      });
      const names = await withConnection(async (conn) => {
        const result = await conn.runAndReadAll(
          `SELECT name FROM read_parquet('${path.join(dir, "data", table.file)}') ORDER BY name`,
        );
        return result.getRowObjects().map((r) => String(r.name));
      });
      expect(names).toContain("Hessen");
      expect(names).toContain("Bayern");
    },
  );

  it(
    "counts the counties of Hesse from a state scope",
    { timeout: 5 * MINUTES },
    async () => {
      const { count, query } = await countOverture({
        theme: "divisions",
        scope: { type: "state", code: "DE-HE" },
        semantics: "within",
        level: "county",
        release: RELEASE,
      });
      expect(count).toBe(27);
      expect(query).toContain(`region = 'DE-HE'`);
      expect(query).toContain(`subtype = 'county'`);
    },
  );

  it(
    "finds Frankfurt by name and lands only its districts",
    { timeout: 10 * MINUTES },
    async () => {
      const index = await countryDivisionIndex(RELEASE, "DE");
      const levels = aggregateLevels(index);
      expect(levels.find((l) => l.subtype === "region")?.count).toBe(16);

      const [frankfurt] = searchIndex(index, "Frankfurt am Main");
      expect(frankfurt).toBeDefined();

      const table = await importOverture(testAccountScope(), {
        theme: "divisions",
        scope: {
          type: "division",
          id: frankfurt.divisionId,
          label: frankfurt.name,
        },
        level: "macrohood",
        release: RELEASE,
        name: "ffm_districts",
      });
      // Frankfurt's Stadtteile land as macrohoods; strictly-inside count
      // is stable for a pinned release.
      expect(table.rowCount).toBeGreaterThanOrEqual(30);
      expect(table.rowCount).toBeLessThanOrEqual(60);
      const names = await withConnection(async (conn) => {
        const result = await conn.runAndReadAll(
          `SELECT name FROM read_parquet('${path.join(dir, "data", table.file)}')`,
        );
        return result.getRowObjects().map((r) => String(r.name));
      });
      expect(names).toContain("Gallus");
      expect(names).toContain("Niederrad");
      // Offenbach is a neighboring city — never inside Frankfurt.
      expect(names).not.toContain("Offenbach am Main");
    },
  );

  it(
    "regression: a small rectangle imports no country-sized polygon",
    { timeout: 10 * MINUTES },
    async () => {
      const within = await countOverture({
        theme: "divisions",
        scope: { type: "bbox", bbox: FRANKFURT },
        semantics: "within",
        level: "country",
        release: RELEASE,
      });
      expect(within.count).toBe(0);

      // Even intersect no longer matches world-spanning bboxes: only
      // Germany's polygon truly crosses the rectangle.
      const intersect = await countOverture({
        theme: "divisions",
        scope: { type: "bbox", bbox: FRANKFURT },
        semantics: "intersect",
        level: "country",
        release: RELEASE,
      });
      expect(intersect.count).toBe(1);

      const municipalities = await countOverture({
        theme: "divisions",
        scope: { type: "bbox", bbox: FRANKFURT },
        semantics: "within",
        level: "locality",
        release: RELEASE,
      });
      expect(municipalities.count).toBeGreaterThan(0);
      expect(municipalities.count).toBeLessThan(500);
    },
  );

  it(
    "city-states are findable: Berlin ranks first and scopes correctly",
    { timeout: 5 * MINUTES },
    async () => {
      const index = await countryDivisionIndex(RELEASE, "DE");
      const [berlin] = searchIndex(index, "Berlin");
      expect(berlin.name).toBe("Berlin");
      expect(berlin.subtype).toBe("region");
      expect(berlin.region).toBe("DE-BE");
      // Berlin's extent backs fit-to-selection: a small box around
      // 13.4°E / 52.5°N.
      expect(berlin.bbox[0]).toBeGreaterThan(12);
      expect(berlin.bbox[2]).toBeLessThan(14.5);

      const countries = await listDivisionCountries(RELEASE);
      const germany = countries.find((c) => c.code === "DE");
      expect(germany).toBeDefined();
      // Germany's extent: roughly 5–16°E, 47–56°N.
      expect(germany!.bbox[0]).toBeGreaterThan(4);
      expect(germany!.bbox[1]).toBeGreaterThan(46);
      expect(germany!.bbox[2]).toBeLessThan(17);
      expect(germany!.bbox[3]).toBeLessThan(56);
    },
  );

  it(
    "per-level scoped counts: Berlin state answers from the index, zero levels absent",
    { timeout: 5 * MINUTES },
    async () => {
      const { levels } = await countOvertureLevels({
        theme: "divisions",
        release: RELEASE,
        scope: { type: "state", code: "DE-BE" },
        semantics: "within",
      });
      const bySubtype = Object.fromEntries(
        levels.map((l) => [l.subtype, l.count]),
      );
      // Berlin the state is exactly one region; every listed level is
      // non-zero; nothing claims the whole country's 22,994 cities.
      expect(bySubtype.region).toBe(1);
      expect(levels.every((l) => l.count > 0)).toBe(true);
      expect(levels.every((l) => l.count < 20_000)).toBe(true);
      expect(levels.length).toBeGreaterThanOrEqual(2);
    },
  );

  it(
    "per-level scoped counts for a drawn rectangle share the import's filters",
    { timeout: 10 * MINUTES },
    async () => {
      const { levels, query } = await countOvertureLevels({
        theme: "divisions",
        release: RELEASE,
        scope: { type: "bbox", bbox: FRANKFURT },
        semantics: "within",
      });
      expect(query).toContain("ST_Within(geometry");
      const bySubtype = Object.fromEntries(
        levels.map((l) => [l.subtype, l.count]),
      );
      // No country fits inside the rectangle — the level is absent, the
      // regression restated through the surface.
      expect(bySubtype.country).toBeUndefined();
      expect(bySubtype.locality).toBeGreaterThan(0);
      expect(levels.every((l) => l.count > 0)).toBe(true);
      expect(levels.every((l) => l.samples.length > 0)).toBe(true);
    },
  );
});
