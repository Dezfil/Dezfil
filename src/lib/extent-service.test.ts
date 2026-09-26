import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { createMap } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import { getLayer } from "@/lib/metadata/maps";
import { layerExtent } from "./extent-service";
import { dimsToFilters } from "./extent-dims";

/**
 * The server-side extent. What matters here is that the constraints
 * reach the query — the browser can already answer the unconstrained
 * case for itself — and that nothing surviving reads as empty rather
 * than as a failure.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
});

afterEach(async () => {
  closeMetadataDb();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

const SQL = `
  SELECT * FROM (VALUES
    (1, ST_Point(0, 0)),
    (2, ST_Point(10, 10)),
    (3, ST_Point(50, 50))
  ) AS t(n, geom)
`;

async function layerOf(sql = SQL) {
  const map = createMap("extent");
  const created = await createLayer(map.id, { name: "l", sql });
  return getLayer(created.id)!;
}

describe("a layer's current extent", () => {
  it("spans every feature when nothing constrains it", async () => {
    const extent = await layerExtent(await layerOf());
    expect(extent.kind).toBe("extent");
    if (extent.kind !== "extent") return;
    expect(extent.box).toEqual([0, 0, 50, 50]);
  });

  it("narrows to the features a stated constraint leaves", async () => {
    // The constraint arrives as an extra, exactly as a canvas-enforced
    // range or a reader's selection would.
    const extent = await layerExtent(await layerOf(), [
      { field: "n", kind: "range", min: null, max: 2 },
    ]);
    expect(extent.kind).toBe("extent");
    if (extent.kind !== "extent") return;
    expect(extent.box).toEqual([0, 0, 10, 10]);
  });

  it("reports empty — not a failure — when nothing survives", async () => {
    const extent = await layerExtent(await layerOf(), [
      { field: "n", kind: "range", min: 900, max: 999 },
    ]);
    expect(extent.kind).toBe("empty");
  });

  it("honours the layer's own stored filters as well as the extras", async () => {
    const layer = await layerOf();
    const stored = {
      ...layer,
      filters: [
        { field: "n", kind: "range" as const, min: null, max: 2 },
      ],
    };
    const extent = await layerExtent(stored);
    expect(extent.kind).toBe("extent");
    if (extent.kind !== "extent") return;
    expect(extent.box).toEqual([0, 0, 10, 10]);
  });
});

describe("composing the caller's constraints with the layer's own", () => {
  const SQL_T = `
    SELECT * FROM (VALUES
      ('2024-01-15'::TIMESTAMP, ST_Point(0, 0)),
      ('2024-02-15'::TIMESTAMP, ST_Point(40, 40))
    ) AS t(ts, geom)
  `;

  it("REPLACES a restated time filter rather than intersecting it", async () => {
    // The stored bound is January; the caller states February, which is
    // what the canvas is drawing. Appending would query January AND
    // February, find nothing, and report empty while February is on
    // screen — the defect this composition exists to prevent.
    const layer = await layerOf(SQL_T);
    const january = {
      ...layer,
      filters: [
        {
          field: "ts",
          kind: "timerange" as const,
          min: "2024-01-01",
          max: "2024-01-31",
        },
      ],
    };
    const extent = await layerExtent(january, [
      { field: "ts", kind: "timerange", min: "2024-02-01", max: "2024-02-28" },
    ]);
    expect(extent.kind).toBe("extent");
    if (extent.kind !== "extent") return;
    expect(extent.box).toEqual([40, 40, 40, 40]);
  });

  it("accepts a bound in the serialized form the client sends", async () => {
    // The client converts epoch milliseconds back to a bound; a value
    // carrying ISO's trailing Z is rejected by the filter's format, so
    // this is the arm that catches a serialization drift.
    const layer = await layerOf(SQL_T);
    const bound = dimsToFilters([
      {
        field: "ts",
        kind: "timerange",
        range: [Date.UTC(2024, 0, 1), Date.UTC(2024, 0, 31)],
      },
    ]);
    const extent = await layerExtent(layer, bound);
    expect(extent.kind).toBe("extent");
    if (extent.kind !== "extent") return;
    expect(extent.box).toEqual([0, 0, 0, 0]);
  });

  it("keeps a category selection alongside a stored filter on the same field", async () => {
    const layer = await layerOf();
    const extent = await layerExtent(
      { ...layer, filters: [{ field: "n", kind: "range", min: null, max: 2 }] },
      [{ field: "n", kind: "values", values: ["1"], exclude: true }],
    );
    // The stored range keeps rows 1–2; excluding "1" leaves row 2 only.
    expect(extent.kind).toBe("extent");
    if (extent.kind !== "extent") return;
    expect(extent.box).toEqual([10, 10, 10, 10]);
  });
});
