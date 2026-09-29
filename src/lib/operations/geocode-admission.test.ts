import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { updateTableData, getTableByName } from "@/lib/metadata/tables";
import { compileOperation } from "./compile";
import { maxBatchRows } from "./compile-geocode";

/**
 * What geocoding refuses before a job exists.
 *
 * **Every one of these is refusable without spending a request**, which is the
 * whole reason the admission line matters more for this verb than for any
 * other: the alternative spends a provider's quota to find out what the
 * registry already knew.
 */

let dir: string;

const ADDRESSES = ["label,address,count", "a,Alexanderplatz,3", "b,Hackescher Markt,4"].join("\n");
const POINTS = ["name,lon,lat", "x,13.4,52.5"].join("\n");
/** A table already carrying one of the columns the verb writes. */
const COLLIDING = ["address,geocode_status", "Alexanderplatz,who knows"].join("\n");

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-geocode-admit-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  process.env.DEZFIL_GEOCODER_URL = "https://example.invalid/search";
  closeMetadataDb();
  resetQueryInstance();
  await writeFile(path.join(dir, "addresses.csv"), `${ADDRESSES}\n`);
  await ingestFile(testAccountScope(), path.join(dir, "addresses.csv"), "addresses.csv");
  await writeFile(path.join(dir, "points.csv"), `${POINTS}\n`);
  await ingestFile(testAccountScope(), path.join(dir, "points.csv"), "points.csv");
  await writeFile(path.join(dir, "colliding.csv"), `${COLLIDING}\n`);
  await ingestFile(testAccountScope(), path.join(dir, "colliding.csv"), "colliding.csv");
});

afterEach(async () => {
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  delete process.env.DEZFIL_GEOCODER_URL;
  await rm(dir, { recursive: true, force: true });
});

const compile = (parameters: Record<string, unknown>) =>
  compileOperation("geocode_addresses", parameters);

const good = { input: "addresses", column: "address", name: "located" };

describe("admission refuses what it can know", () => {
  it("admits the ordinary case, and prepares rather than compiling SQL", async () => {
    const compiled = await compile(good);
    // There is no statement yet: it names a staging path nothing has written.
    expect(compiled.sql).toBe("");
    expect(typeof compiled.prepare).toBe("function");
    // The generation the answers will be joined to, captured before a single
    // request is spent.
    expect(compiled.bindings).toEqual({
      addresses: getTableByName("addresses")!.file,
    });
    // And a dry run's answer, which needs no provider at all.
    expect(compiled.preview).toMatchObject({ rowCount: 2, geometryType: "POINT" });
  });

  it("refuses an unknown input", async () => {
    await expect(compile({ ...good, input: "nope" })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("refuses a missing address column, and an unknown one", async () => {
    await expect(compile({ input: "addresses", name: "x" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      compile({ ...good, column: "not_a_column" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("refuses a column that is not text", async () => {
    const error = await compile({ ...good, column: "count" }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: "invalid_request" });
    // The message says what is wrong and what to do, not just "no".
    expect(String((error as Error).message)).toMatch(/text/i);
  });

  it("refuses an input that already carries geometry", async () => {
    const error = await compile({
      input: "points",
      column: "name",
      name: "x",
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "invalid_request" });
    // Naming the column in the way is what makes the refusal actionable.
    expect(String((error as Error).message)).toContain("geometry");
  });

  it("refuses each generated column that would collide, case-insensitively", async () => {
    const error = await compile({
      input: "colliding",
      column: "address",
      name: "x",
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "invalid_request" });
    expect(String((error as Error).message)).toContain("geocode_status");
  });

  it("refuses when no endpoint is configured at all", async () => {
    delete process.env.DEZFIL_GEOCODER_URL;
    await expect(compile(good)).rejects.toMatchObject({
      code: "geocoder_unconfigured",
    });
  });
});

/**
 * The bound, and that it is derived.
 *
 * **The expected number is computed here from a formula stated independently**,
 * not by calling the production function — a test that asked the code what it
 * thought the bound was would pass for any bound, including a wrong one.
 */
describe("the derived bound", () => {
  /**
   * The formula, written out here rather than borrowed from the production
   * function — a test that calls what it is checking asserts nothing.
   *
   * A row costs the pace or the request deadline, whichever is longer, **and
   * it may cost that twice**: J8 retries a transport failure once before
   * failing the run, so a run where every first exchange burns its deadline
   * and every retry succeeds is valid and spends two slots per row. One query
   * timeout is held back for publication, which is itself a query.
   */
  const ATTEMPTS = 2;
  const expected = (paceMs: number, requestS: number) =>
    Math.floor(
      (600_000 - 60_000) / (Math.max(paceMs, requestS * 1000) * ATTEMPTS),
    );

  /** Claim a row count without ingesting that many rows: the bound reads the
   * registry, which is the contract, and ingesting 55 rows to prove a boundary
   * would test the CSV reader instead. Every other field is written back as it
   * was, since this update replaces the whole row. */
  const claimRows = (rows: number) => {
    const table = getTableByName("addresses")!;
    return updateTableData(
      { name: table.name, id: table.id },
      {
        file: table.file,
        geometryColumn: table.geometryColumn,
        geometryType: table.geometryType,
        crsAssumed: table.crsAssumed,
        headerSuspect: false,
        rowCount: rows,
        importedAt: table.importedAt ?? new Date().toISOString(),
      },
    );
  };

  afterEach(() => {
    delete process.env.DEZFIL_GEOCODE_PACE_MS;
    delete process.env.DEZFIL_GEOCODE_REQUEST_TIMEOUT_S;
  });

  it("accepts exactly the maximum and refuses one row past it", async () => {
    const bound = expected(1000, 10);
    expect(maxBatchRows()).toBe(bound);

    claimRows(bound);
    await expect(compile(good)).resolves.toMatchObject({ name: "located" });

    claimRows(bound + 1);
    const error = await compile(good).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "invalid_request" });
    // Both numbers, so the refusal can be acted on rather than guessed at.
    expect(String((error as Error).message)).toContain(String(bound + 1));
    expect(String((error as Error).message)).toContain(String(bound));
  });

  it("moves with the request deadline, and not with the pace alone", async () => {
    // A slower pace than the deadline: now the pace is what a row costs.
    process.env.DEZFIL_GEOCODE_PACE_MS = "20000";
    expect(maxBatchRows()).toBe(expected(20_000, 10));

    // And a longer deadline moves it while the pace stays put — which is the
    // half a pace-only bound would have got wrong.
    delete process.env.DEZFIL_GEOCODE_PACE_MS;
    process.env.DEZFIL_GEOCODE_REQUEST_TIMEOUT_S = "30";
    expect(maxBatchRows()).toBe(expected(1000, 30));
    expect(maxBatchRows()).toBeLessThan(expected(1000, 10));

    // A faster pace under a slow provider changes nothing at all: the answer
    // is dominated by how long the provider takes.
    process.env.DEZFIL_GEOCODE_PACE_MS = "10";
    expect(maxBatchRows()).toBe(expected(1000, 30));
  });
});
