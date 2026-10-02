import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance, withConnection } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { getTableByName, updateTableData, type DataTable } from "@/lib/metadata/tables";
import { createMap } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import { limits } from "@/lib/limits";
import { testAccountScope } from "@/lib/test-support/accounts";
import type { AccountScope } from "@/lib/auth/scope";
import { getPublishedView, publishMap, resetPublishCache } from "./publish-service";
import { resetRateLimits } from "./rate-limit";

/**
 * A published link draws the data its datasets hold now. Ada publishes a map
 * of her `roads`; the link is read, then her dataset gets a new artifact the
 * way a refresh or a rerun of its producing step swaps one in (same dataset,
 * same name, a new file, the old one retired). Once the freshness bound has
 * passed, the link draws the new rows, never the retired artifact.
 */
const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
let ada: AccountScope;
let roads: DataTable;
let token: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "publication-artifacts-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb(); resetQueryInstance(); resetPublishCache(); resetRateLimits();
  ada = testAccountScope(undefined, "ada");
  const file = path.join(directory, "roads.csv");
  await writeFile(file, "sentinel,lon,lat\nbefore,1,2\n");
  roads = await ingestFile(ada, file, "roads.csv");
  const map = createMap(ada, "Survey");
  await createLayer(ada, map.id, { name: "Roads", sql: "SELECT * FROM roads" });
  token = publishMap(ada, map.id).token;
});
afterEach(async () => {
  closeMetadataDb(); resetQueryInstance(); resetPublishCache(); vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

type Rendered = { ok: boolean; error?: { message: string }; geojson?: { features: { properties: Record<string, unknown> }[] } };
async function drawn(now: number): Promise<unknown> {
  const view = await getPublishedView(token, now);
  const render = view!.layers.find((layer) => layer.name === "Roads")!.render as Rendered;
  return render.ok ? render.geojson!.features.map((feature) => feature.properties.sentinel) : render.error?.message;
}

/** Swap a new artifact into the dataset as a refresh does, and retire the old. */
async function swapArtifact(sentinel: string): Promise<void> {
  const next = path.join("tables", `${sentinel}.parquet`);
  await withConnection(async (conn) => {
    await conn.run(`COPY (SELECT * REPLACE ('${sentinel}' AS sentinel) FROM read_parquet('${path.join(directory, roads.file)}'))
      TO '${path.join(directory, next)}' (FORMAT PARQUET)`);
  });
  expect(updateTableData({ name: roads.name, id: roads.id }, {
    file: next, geometryColumn: roads.geometryColumn, geometryType: roads.geometryType, crsAssumed: roads.crsAssumed,
    headerSuspect: false, rowCount: 1, importedAt: new Date().toISOString(),
  })).toBe(true);
  await rm(path.join(directory, roads.file));
  roads = getTableByName(roads.name)!;
}

describe("a published link after its input's artifact changes", () => {
  it("draws the new rows once the freshness bound has passed, never the retired artifact", async () => {
    const start = Date.now();
    expect(await drawn(start)).toEqual(["before"]);
    await swapArtifact("after");
    const later = start + limits.publishFreshnessS * 1000 + 1;
    expect(await drawn(later)).toEqual(["after"]);
    await swapArtifact("again");
    expect(await drawn(later + limits.publishFreshnessS * 1000 + 1)).toEqual(["again"]);
  });
});
