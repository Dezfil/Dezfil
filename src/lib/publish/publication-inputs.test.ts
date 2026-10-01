import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { createMap } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import type { DataTable } from "@/lib/metadata/tables";
import type { AccountScope } from "@/lib/auth/scope";
import { testAccountScope } from "@/lib/test-support/accounts";
import { shareProject } from "@/lib/test-support/sharing";
import { getPublishedView, publishMap, resetPublishCache } from "./publish-service";
import { cachedPublicationInputs } from "./publication-resolution";

/**
 * A published view held for its freshness bound records what its assembly
 * drew: every layer and widget evaluation it ran. Ada publishes a map that
 * draws her `roads` and Bob's `bob.roads` (Bob files his in project P, where
 * Ada is a viewer); she also owns `parks`, which the map does not name.
 */
const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
let scopes: Record<string, AccountScope>;
let tables: Record<string, DataTable>;

beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "publication-inputs-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb(); resetQueryInstance(); resetPublishCache();
  scopes = Object.fromEntries(["ada", "bob"].map((id) => [id, testAccountScope(undefined, id)]));
  tables = {};
  for (const [owner, name] of [["ada", "roads"], ["ada", "parks"], ["bob", "roads"]] as const) {
    const file = path.join(directory, `${owner}-${name}.csv`);
    await writeFile(file, `sentinel,lon,lat\n${owner} ${name},1,2\n`);
    tables[`${owner}.${name}`] = await ingestFile(scopes[owner], file, `${name}.csv`);
  }
  shareProject("bob", "P", [["ada", "viewer"]], [tables["bob.roads"].id]);
});
afterEach(async () => { resetPublishCache(); closeMetadataDb(); resetQueryInstance(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

describe("a held published view records what it drew", () => {
  it("names the datasets its layers' evaluations bound, and nothing else of the owner's", async () => {
    const map = createMap(scopes.ada, "Survey");
    await createLayer(scopes.ada, map.id, { name: "Mine", sql: "SELECT * FROM roads" });
    await createLayer(scopes.ada, map.id, { name: "Theirs", sql: "SELECT * FROM bob.roads" });
    const { token } = publishMap(scopes.ada, map.id);
    expect(cachedPublicationInputs(token)).toBeNull();
    expect(await getPublishedView(token, Date.now())).not.toBeNull();
    const inputs = cachedPublicationInputs(token)!;
    expect(inputs.catalogue).toBe(false);
    expect(inputs.datasets.map((input) => input.id).sort()).toEqual([tables["ada.roads"].id, tables["bob.roads"].id].sort());
    expect(inputs.datasets.find((input) => input.id === tables["ada.roads"].id)?.file).toBe(tables["ada.roads"].file);
  });
});
