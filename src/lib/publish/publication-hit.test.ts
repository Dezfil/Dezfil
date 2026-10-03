import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
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
import { shareProject, unfileDataset } from "@/lib/test-support/sharing";
import { getPublishedView, publishMap, resetPublishCache } from "./publish-service";

/**
 * A held published view is served like any retained artifact: on a hit, only
 * while the link may still be served everything it drew. Ada's published map
 * draws Bob's `bob.roads`, which Bob files in his project Q where Ada is a
 * viewer; then Bob withdraws it.
 *
 * The cache's own revision already moves with the owner's reach, which makes
 * this rule unobservable through it; the revision is pinned here so the hit
 * reaches the authorization, which is what is under test.
 */
vi.mock("@/lib/query/namespace", async (original) => ({
  ...await original<typeof import("@/lib/query/namespace")>(),
  publicationRevision: () => "pinned",
}));

const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
let scopes: Record<string, AccountScope>;
let bobs: DataTable;

beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "publication-hit-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb(); resetQueryInstance(); resetPublishCache();
  scopes = Object.fromEntries(["ada", "bob"].map((id) => [id, testAccountScope(undefined, id)]));
  const file = path.join(directory, "roads.csv");
  await writeFile(file, "sentinel,lon,lat\nbob's road,1,2\n");
  bobs = await ingestFile(scopes.bob, file, "roads.csv");
  shareProject("bob", "Q", [["ada", "viewer"]], [bobs.id]);
});
afterEach(async () => { resetPublishCache(); closeMetadataDb(); resetQueryInstance(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

type View = { layers: { render: { ok: boolean; geojson?: { features: { properties: { sentinel: string } }[] } } }[] };

describe("a held published view on a hit", () => {
  it("is not served once the owner no longer reaches what it drew", async () => {
    const map = createMap(scopes.ada, "Survey");
    await createLayer(scopes.ada, map.id, { name: "Bob's", sql: "SELECT * FROM bob.roads" }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    const { token } = publishMap(scopes.ada, map.id, {}, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    const first = await getPublishedView(token, Date.now()) as unknown as View;
    expect(first.layers[0].render.geojson?.features.map((f) => f.properties.sentinel)).toEqual(["bob's road"]);

    unfileDataset("Q", bobs.id);
    const after = await getPublishedView(token, Date.now()) as unknown as View;
    expect(after.layers[0].render.ok).toBe(false);
    expect(JSON.stringify(after)).not.toContain("bob's road");
  });
});
