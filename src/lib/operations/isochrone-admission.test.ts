import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { closeMetadataDb } from "@/lib/metadata/db";
import { getTableByName } from "@/lib/metadata/tables";
import { limits } from "@/lib/limits";
import { compileOperation } from "./compile";
import {
  ATTEMPTS_PER_ORIGIN,
  maxIsochroneOrigins,
} from "./compile-isochrone";

/**
 * Admission for the isochrone verb ('s API half): everything refusable
 * is refused before a job exists — before a single request is spent.
 */

let dir: string;

const POINTS = [
  "name,lon,lat",
  "a,13.4,52.5",
  "b,13.5,52.5",
  "c,13.6,52.5",
].join("\n");
/** A table already carrying one of the columns the verb writes. */
const COLLIDING = ["name,lon,lat,band_minutes", "a,13.4,52.5,9"].join("\n");
const NO_GEOMETRY = ["label,value", "a,1"].join("\n");

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-iso-admit-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  process.env.DEZFIL_ISOCHRONE_URL = "https://router.invalid/isochrone";
  closeMetadataDb();
  resetQueryInstance();
  await writeFile(path.join(dir, "points.csv"), `${POINTS}\n`);
  await ingestFile(testAccountScope(), path.join(dir, "points.csv"), "points.csv");
  await writeFile(path.join(dir, "colliding.csv"), `${COLLIDING}\n`);
  await ingestFile(testAccountScope(), path.join(dir, "colliding.csv"), "colliding.csv");
  await writeFile(path.join(dir, "plain.csv"), `${NO_GEOMETRY}\n`);
  await ingestFile(testAccountScope(), path.join(dir, "plain.csv"), "plain.csv");
});

afterEach(async () => {
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  delete process.env.DEZFIL_ISOCHRONE_URL;
  delete process.env.DEZFIL_ISOCHRONE_PACE_MS;
  delete process.env.DEZFIL_ISOCHRONE_REQUEST_TIMEOUT_S;
  delete process.env.DEZFIL_OPERATION_TIMEOUT_S;
  await rm(dir, { recursive: true, force: true });
});

const compile = (parameters: Record<string, unknown>) =>
  compileOperation("isochrone", parameters);

const good = {
  input: "points",
  travel_mode: "driving",
  bands: [5, 10],
  name: "reachable",
};

describe("the ordinary case, admitted", () => {
  it("prepares rather than compiling SQL, and answers the dry run itself", async () => {
    const compiled = await compile(good);
    expect(compiled.sql).toBe("");
    expect(typeof compiled.prepare).toBe("function");
    expect(compiled.bindings).toEqual({
      points: getTableByName("points")!.file,
    });
    // Origins × bands (the rule's count): three origins, two bands.
    expect(compiled.preview).toMatchObject({
      rowCount: 6,
      geometryType: "POLYGON",
    });
  });

  it("the input's own active geometry column never counts as a collision (K3)", async () => {
    // The CSV builder names its geometry column — the verb replaces it, so
    // its name colliding with the output's `geom` is the point, not a fault.
    await expect(compile(good)).resolves.toBeDefined();
  });
});

describe("admission refuses what it can know", () => {
  const refused = (parameters: Record<string, unknown>, pattern: RegExp) =>
    expect(compile(parameters)).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringMatching(pattern),
    });

  it("an unknown input", () =>
    expect(compile({ ...good, input: "nope" })).rejects.toMatchObject({
      code: "not_found",
    }));

  it("an input with no geometry", () =>
    refused({ ...good, input: "plain" }, /has no geometry/));

  it("no bands, too many bands, a fractional band, and a duplicate", async () => {
    await refused({ ...good, bands: [] }, /bands/i);
    await refused({ ...good, bands: [1, 2, 3, 4, 5] }, /at most 4/);
    await refused({ ...good, bands: [7.5] }, /whole number/);
    await refused({ ...good, bands: [-3] }, /whole number/);
    await refused({ ...good, bands: [10, 10] }, /asked once/);
  });

  it("an unknown travel mode", () =>
    refused({ ...good, travel_mode: "teleport" }, /not a way of travelling/));

  it("a generated column colliding case-insensitively", () =>
    refused({ ...good, input: "colliding" }, /band_minutes/));

  it("unconfigured is a coded refusal, and the verb still exists", async () => {
    delete process.env.DEZFIL_ISOCHRONE_URL;
    await expect(compile(good)).rejects.toMatchObject({
      code: "isochrone_unconfigured",
      message: expect.stringMatching(/DEZFIL_ISOCHRONE_URL/),
    });
  });
});

describe("the bound is derived and counts origins (K9)", () => {
  it("refuses at one past the maximum, computed from the formula, and bands do not move it", async () => {
    // The oracle is K9's formula stated here, not the production function:
    // floor((operation budget − query timeout) / (max(pace, deadline) × 2)).
    process.env.DEZFIL_ISOCHRONE_PACE_MS = "1000";
    process.env.DEZFIL_ISOCHRONE_REQUEST_TIMEOUT_S = "20";
    process.env.DEZFIL_OPERATION_TIMEOUT_S = "600";
    const expected = Math.floor(
      (600_000 - limits.queryTimeoutMs) /
        (Math.max(1000, 20_000) * ATTEMPTS_PER_ORIGIN),
    );
    expect(maxIsochroneOrigins()).toBe(expected);
    // Three origins is inside any sane bound; shrink the budget until the bound is exactly two, so
    // the three-row fixture is one past it. available = bound × perOrigin + queryTimeout ⇒ bound 2
    // needs 2 × 40s + queryTimeout of budget.
    process.env.DEZFIL_OPERATION_TIMEOUT_S = String(
      Math.ceil((2 * 40_000 + limits.queryTimeoutMs) / 1000),
    );
    expect(maxIsochroneOrigins()).toBe(2);
    await expect(compile(good)).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringMatching(/2 origins in one run/),
    });
    // Doubling the bands changes nothing: they travel together (K9).
    await expect(
      compile({ ...good, bands: [5, 10, 15, 20] }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/2 origins in one run/),
    });
    // And at exactly the maximum, admission accepts.
    process.env.DEZFIL_OPERATION_TIMEOUT_S = String(
      Math.ceil((3 * 40_000 + limits.queryTimeoutMs) / 1000),
    );
    expect(maxIsochroneOrigins()).toBe(3);
    await expect(compile(good)).resolves.toBeDefined();
  });
});
