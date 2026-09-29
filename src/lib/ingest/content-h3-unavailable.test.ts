import { testAccountScope } from "@/lib/test-support/accounts";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ingestFile } from "./ingest";
import { closeMetadataDb } from "@/lib/metadata/db";

vi.mock("@/lib/duckdb", async original => ({
  ...await original<typeof import("@/lib/duckdb")>(), trustedH3Ready: async () => false,
}));
afterEach(() => { closeMetadataDb(); delete process.env.DEZFIL_DATA_DIR; });

it("an unavailable H3 validator still publishes a plain CSV with an explicitly unvalidated hint", async () => {
  const dir = await mkdtemp(path.join(process.cwd(), ".tmp-no-h3-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  try {
    const file = path.join(dir, "cells.csv");
    await writeFile(file, "payload,label\n8928308280fffff,a\n");
    const table = await ingestFile(testAccountScope(), file, "cells.csv");
    expect(table).toMatchObject({
      rowCount: 1, geometryColumn: null, geometryRecord: null, crsAssumed: false,
      geometryCandidates: [{ format: "h3", applied: false, strength: "weak", sample: { rows: 1, nonNull: 1, readable: null }, reasons: ["h3-unavailable"] }],
    });
  } finally {
    closeMetadataDb();
    await rm(dir, { recursive: true, force: true });
  }
});
