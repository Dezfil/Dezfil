import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { getTileRecord } from "@/lib/metadata/tiles";
import { createMap } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import type { Layer } from "@/lib/metadata/maps";
import type { AccountScope } from "@/lib/auth/scope";
import { testAccountScope } from "@/lib/test-support/accounts";
import { shareProject } from "@/lib/test-support/sharing";
import { privateTileAccess } from "./access";
import { ensureTiles, resetTileBuilds, tileBuildsSettled } from "./build";
import { tileArchivePath } from "./paths";
import { readPrivateTile } from "./private-service";

/**
 * A lower-reach caller's failed build never replaces another caller's valid
 * archive or the layer's shared status. Ada's map in project P draws her
 * `roads`, which she keeps to herself; Bob is a viewer of P. Ada warms the
 * layer's archive. Bob asks for the layer's tiles: the archive is beyond his
 * reach, so he gets an attempt of his own, keyed by his reach, and it fails
 * on the input he cannot reach. His failure is his alone: Ada's record, her
 * archive bytes and her ready status are untouched, and Bob's next request
 * reports his own failure without another attempt.
 */
const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
let scopes: Record<string, AccountScope>;
let layer: Layer;

beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "build-isolation-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  vi.stubEnv("DEZFIL_RENDER_CAP_FEATURES", "1");
  closeMetadataDb(); resetQueryInstance(); resetTileBuilds();
  scopes = Object.fromEntries(["ada", "bob"].map((id) => [id, testAccountScope(undefined, id)]));
  const file = path.join(directory, "roads.csv");
  await writeFile(file, "sentinel,lon,lat\na,1,2\nb,3,4\nc,5,6\n");
  await ingestFile(scopes.ada, file, "roads.csv");
  shareProject("ada", "P", [["bob", "viewer"]]);
  const map = createMap(scopes.ada, "Survey", "P");
  layer = await createLayer(scopes.ada, map.id, { name: "Roads", sql: "SELECT * FROM roads" });
});
afterEach(async () => {
  await tileBuildsSettled();
  closeMetadataDb(); resetQueryInstance(); resetTileBuilds(); vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

/** The request the tile path makes for the layer, without the render's own
 * evaluation: freshness then goes by the current archive's recorded inputs. */
const request = () => ({ layerId: layer.id, sql: layer.sql, filters: [], geometryColumn: "geometry",
  columns: ["sentinel", "lon", "lat"], projection: "" });

describe("a lower-reach caller's failed build", () => {
  it("leaves the owner's archive, record and ready status untouched", async () => {
    const ada = privateTileAccess(scopes.ada, layer.id);
    expect(ensureTiles(ada, request()).state).toBe("building");
    await tileBuildsSettled();
    expect(ensureTiles(ada, request()).state).toBe("ready");
    const record = getTileRecord(layer.id);
    const bytes = await readFile(tileArchivePath(layer.id));

    // Bob may not be served Ada's archive, so his request starts his own
    // attempt, which fails on `roads`, beyond his reach.
    const bob = privateTileAccess(scopes.bob, layer.id);
    expect(ensureTiles(bob, request()).state).toBe("building");
    // While his attempt waits or runs, Ada's archive stays ready for her.
    expect(ensureTiles(ada, request()).state).toBe("ready");
    await tileBuildsSettled();
    const failed = ensureTiles(bob, request());
    expect(failed.state).toBe("failed");
    expect(failed.error).toContain('"roads" is not available to you');

    expect(getTileRecord(layer.id)).toEqual(record);
    expect(await readFile(tileArchivePath(layer.id))).toEqual(bytes);
    expect(ensureTiles(ada, request())).toMatchObject({ state: "ready", featureCount: 3 });
    expect(await readPrivateTile(scopes.ada, layer.id, 0, 0, 0)).not.toBeNull();
    // Bob's failure is recorded against his attempt and sticks for him.
    expect(ensureTiles(bob, request()).state).toBe("failed");
    await tileBuildsSettled();
    expect(getTileRecord(layer.id)).toEqual(record);
  });
});
