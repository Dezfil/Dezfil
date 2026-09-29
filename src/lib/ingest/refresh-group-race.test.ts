import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { getTableByName } from "@/lib/metadata/tables";
import { removeTable } from "@/lib/table-service";
import { resetQueryInstance } from "@/lib/duckdb";
import { ApiError } from "@/lib/api/errors";
import { importOsm } from "@/lib/osm/import";
import { refreshTable } from "./refresh";
import { resetRefreshFences } from "./fence";
import { retirementsSettled } from "./retire";

/**
 * The record's named promotion: the OSM GROUP analog of
 * refresh-racing-delete, driven as a group-level race through the real
 * import and refresh services — a member deleted while the group refresh
 * is in flight must stay deleted, the whole group swap must roll back
 * (zero-match ⇒ transaction abort), the surviving member must keep its
 * pre-refresh data, and no candidate artifacts may remain. The
 * verification held this at the metadata layer only.
 */

// Two tagged cafés (points class) and one tagged residential way over two
// untagged nodes (lines class) — a real two-member group.
const OVERPASS_PAYLOAD = {
  version: 0.6,
  generator: "e2e recorded shape",
  elements: [
    { type: "node", id: 1, lat: 52.52, lon: 13.41, tags: { amenity: "cafe", name: "Eins" } },
    { type: "node", id: 2, lat: 52.51, lon: 13.42, tags: { amenity: "cafe", name: "Zwei" } },
    { type: "node", id: 10, lat: 52.53, lon: 13.4 },
    { type: "node", id: 11, lat: 52.54, lon: 13.43 },
    { type: "way", id: 100, nodes: [10, 11], tags: { highway: "residential", name: "Weg" } },
  ],
};

let dir: string;
let server: Server;
let hold = false;
let releaseHold: (() => void) | null = null;
let overpassHit: (() => void) | null = null;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  process.env.DEZFIL_EGRESS_ALLOWLIST = "127.0.0.1";
  closeMetadataDb();
  resetRefreshFences();
  resetQueryInstance();
  hold = false;
  releaseHold = null;
  overpassHit = null;

  server = createServer((_req, res) => {
    void (async () => {
      overpassHit?.();
      if (hold) {
        await new Promise<void>((resolve) => {
          releaseHold = resolve;
        });
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(OVERPASS_PAYLOAD));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.DEZFIL_OVERPASS_URL = `${base}/overpass`;
});

afterEach(async () => {
  releaseHold?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeMetadataDb();
  delete process.env.DEZFIL_DATA_DIR;
  delete process.env.DEZFIL_EGRESS_ALLOWLIST;
  delete process.env.DEZFIL_OVERPASS_URL;
  await rm(dir, { recursive: true, force: true });
});

describe("OSM group refresh racing a member delete", () => {
  // Real import + refresh work inside the test: an explicit budget in
  // place of the 5s default absorbs runner stalls,
  // while a genuine hang still fails within the job's patience.
  it("rolls the whole group swap back, keeps the survivor's data, leaves no residue", { timeout: 60_000 }, async () => {
    const tables = await importOsm(testAccountScope(), {
      selectors: ["amenity", "highway"],
      bbox: [13.3, 52.4, 13.5, 52.6],
      name: "grouprace",
    });
    const names = tables.map((t) => t.name).sort();
    expect(names).toEqual(["grouprace_lines", "grouprace_points"]);
    const pointsBefore = getTableByName("grouprace_points")!;

    // Start the group refresh and hold it at the Overpass fetch — the
    // race window the record describes.
    hold = true;
    const arrived = new Promise<void>((resolve) => {
      overpassHit = resolve;
    });
    const refresh = refreshTable(testAccountScope(), "grouprace_points");
    // The promise must be observed before the race resolves either way.
    const settled = refresh.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await arrived;

    // A member is deleted mid-flight, through the real delete road.
    await removeTable(testAccountScope(), "grouprace_lines");
    expect(getTableByName("grouprace_lines")).toBeNull();

    releaseHold?.();
    const outcome = await settled;

    // The zero-match member aborts the WHOLE swap with the documented
    // coded answer.
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBeInstanceOf(ApiError);
      const apiError = outcome.error as ApiError;
      expect(apiError.code).toBe("not_found");
      expect(apiError.message).toContain(
        "was deleted while the group refresh ran; the group was left as it was",
      );
    }

    // The deleted member stays deleted; the survivor kept its
    // pre-refresh artifact and timestamps — the group was left as it was.
    expect(getTableByName("grouprace_lines")).toBeNull();
    const pointsAfter = getTableByName("grouprace_points")!;
    expect(pointsAfter.file).toBe(pointsBefore.file);
    expect(pointsAfter.importedAt).toBe(pointsBefore.importedAt);
    expect(pointsAfter.rowCount).toBe(pointsBefore.rowCount);

    // Races leave no residue: the tables directory holds exactly the
    // survivor's artifact — every candidate build was cleaned up.
    await retirementsSettled();
    const artifacts = await readdir(
      path.join(process.env.DEZFIL_DATA_DIR!, "tables"),
    );
    expect(artifacts).toEqual([path.basename(pointsBefore.file)]);
  });
});
