import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { testAccountScope, testAccountRequest } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DuckDBConnection } from "@duckdb/node-api";
import { AsyncLocalStorage } from "node:async_hooks";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import * as tables from "@/lib/metadata/owned-tables";
import * as inflight from "@/lib/query/inflight";
import { retirementsSettled } from "@/lib/ingest/retire";
import { createMap } from "@/lib/map-service";
import { documentFacts } from "@/lib/metadata/document-facts";
import { readHold } from "@/lib/test-support/read-hold";
import { GET as summariesGET } from "@/app/api/maps/[id]/sketches/route";
import { GET as featuresGET } from "@/app/api/sketches/[name]/features/route";
import { appendFeature, cascadeDeleteSketch, createSketch, listFeatures, moveVertex } from "./store";

let dir: string;
const readerScope = new AsyncLocalStorage<boolean>();
const point = { kind: "point", geometry: { type: "Point", coordinates: [13.4, 52.5] } };
const polygon = { kind: "polygon", geometry: { type: "Polygon", coordinates: [[
  [13.4, 52.5], [13.5, 52.5], [13.5, 52.6], [13.4, 52.5],
]] } };
type Reader = "summary" | "features";
type Stage = "before artifact" | "partly read";

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-sketch-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await retirementsSettled();
  closeMetadataDb();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

const abs = (file: string) => path.join(process.env.DEZFIL_DATA_DIR!, file);
const exists = (file: string) => access(file).then(() => true, () => false);

async function seed() {
  const map = createMap(testAccountScope(), "Retained sketch");
  const sketch = await createSketch(testAccountScope(), map.id, polygon, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
  const other = await createSketch(testAccountScope(), map.id, point, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
  return { map, sketch, other, facts: documentFacts({ kind: "map", id: map.id }) };
}

function request(reader: Reader, mapId: string, name: string) {
  const req = new Request("http://localhost/api/test");
  return readerScope.run(true, () => reader === "summary"
    ? summariesGET(testAccountRequest(req), { params: Promise.resolve({ id: mapId }) })
    : featuresGET(testAccountRequest(req), { params: Promise.resolve({ name }) }));
}

function captureCount(reader: Reader) {
  let captures = 0;
  if (reader === "summary") {
    const original = tables.listOwnedTables;
    vi.spyOn(tables, "listOwnedTables").mockImplementation((...args) => {
      if (readerScope.getStore()) captures++;
      return original(...args);
    });
  } else {
    const original = tables.getOwnedTableByName;
    vi.spyOn(tables, "getOwnedTableByName").mockImplementation((...args) => {
      if (readerScope.getStore()) captures++;
      return original(...args);
    });
  }
  return () => {
    expect(captures, `${reader}: exactly one table-state capture`).toBe(1);
    console.info(`${reader}: CAPTURES = ${captures}`);
  };
}

/** Observe the actual retirement wait, without replacing its promise. If no
 * reader holds it, drain real unlink before releasing the test's hold. If it
 * is held, assert retention now and drain after release. One event-loop turn
 * flushes the wait's promise reactions; no wall-clock sleep decides success. */
function retirementObserver() {
  const waits: { settled: boolean }[] = [];
  const original = inflight.inflightSettled;
  vi.spyOn(inflight, "inflightSettled").mockImplementation(() => {
    const wait = original();
    const state = { settled: false };
    waits.push(state);
    void wait.then(() => { state.settled = true; });
    return wait;
  });
  return async (expected: number) => {
    expect(waits).toHaveLength(expected);
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (waits.every((wait) => wait.settled)) await retirementsSettled();
  };
}

function holdArtifact(file: string, reader: Reader, stage: Stage, label: string) {
  const hold = readHold(label);
  const original = DuckDBConnection.prototype.runAndReadAll;
  let held = false;
  let opens = 0;
  vi.spyOn(DuckDBConnection.prototype, "runAndReadAll").mockImplementation(async function (this: DuckDBConnection, sql, ...args) {
    if (readerScope.getStore() && sql.includes(file)) {
      opens++;
      const target = reader === "summary" || (stage === "before artifact" ? opens === 1 : opens === 2);
      if (!held && target) {
        held = true;
        // The partly-read hold must be the second open, after count succeeded.
        expect(opens).toBe(stage === "partly read" ? 2 : 1);
        await hold.engage();
      }
    }
    return original.call(this, sql, ...args);
  });
  return hold;
}

async function assertCaptured(response: Response, reader: Reader, seeded: Awaited<ReturnType<typeof seed>>) {
  expect(response.status).toBe(200);
  const body = await response.json();
  if (reader === "features") {
    expect(body).toEqual({ features: [{ id: seeded.sketch.featureId, ...polygon }] });
  } else {
    expect(body).toHaveLength(2);
    expect(body).toEqual(expect.arrayContaining([
      { ...seeded.facts, table: seeded.sketch.table.name, tableId: seeded.sketch.table.id, mapId: seeded.map.id,
        layerId: seeded.sketch.layerId, rowCount: 1, counts: { polygon: 1 } },
      { ...seeded.facts, table: seeded.other.table.name, tableId: seeded.other.table.id, mapId: seeded.map.id,
        layerId: seeded.other.layerId, rowCount: 1, counts: { point: 1 } },
    ]));
  }
}

describe("sketch API artifact retention", () => {
  for (const [reader, stage] of [
    ["summary", "before artifact"],
    ["features", "before artifact"],
    ["features", "partly read"],
  ] as const) {
    it(`${reader} retains captured state across append, held ${stage}`, async () => {
      const seeded = await seed();
      const { sketch, map } = seeded;
      const checkCapture = captureCount(reader);
      const drainUnheld = retirementObserver();
      const hold = holdArtifact(sketch.table.file, reader, stage, `${reader} ${stage}`);
      const reading = request(reader, map.id, sketch.table.name);
      try {
        await hold.beforeMutation();
        const appended = await appendFeature(testAccountScope(), sketch.table.name, point);
        expect(appended.table.file).not.toBe(sketch.table.file);
        await drainUnheld(1);
        expect.soft(await exists(abs(sketch.table.file)), "captured file survives hold").toBe(true);
        hold.release();
        await assertCaptured(await reading, reader, seeded);
        checkCapture();
        await retirementsSettled();
        expect(await exists(abs(sketch.table.file)), "old file removed after release").toBe(false);
        expect(await listFeatures(testAccountScope(), sketch.table.name)).toEqual([
          { id: sketch.featureId, ...polygon }, { id: appended.featureId, ...point },
        ]);
      } finally {
        hold.release();
        await reading;
      }
    });
  }

  for (const reader of ["summary", "features"] as const) {
    it(`${reader} retains one capture across append then vertex move and cleans both files`, async () => {
      const seeded = await seed();
      const { sketch, map } = seeded;
      const checkCapture = captureCount(reader);
      const drainUnheld = retirementObserver();
      const hold = holdArtifact(sketch.table.file, reader, "before artifact", `${reader}`);
      const reading = request(reader, map.id, sketch.table.name);
      try {
        await hold.beforeMutation();
        const appended = await appendFeature(testAccountScope(), sketch.table.name, point);
        await hold.beforeMutation();
        const moved = await moveVertex(testAccountScope(), sketch.table.name, sketch.featureId, 1, [13.6, 52.5]);
        expect(new Set([sketch.table.file, appended.table.file, moved.table.file]).size).toBe(3);
        await drainUnheld(2);
        for (const file of [sketch.table.file, appended.table.file])
          expect.soft(await exists(abs(file)), "superseded file survives held read").toBe(true);
        hold.release();
        await assertCaptured(await reading, reader, seeded);
        checkCapture();
        await retirementsSettled();
        for (const file of [sketch.table.file, appended.table.file])
          expect(await exists(abs(file)), "superseded file removed after release").toBe(false);
        expect(await exists(abs(moved.table.file))).toBe(true);
        const movedPolygon = { ...polygon, geometry: { type: "Polygon", coordinates: [[
          [13.4, 52.5], [13.6, 52.5], [13.5, 52.6], [13.4, 52.5],
        ]] } };
        expect(await listFeatures(testAccountScope(), sketch.table.name)).toEqual([
          { id: sketch.featureId, ...movedPolygon }, { id: appended.featureId, ...point },
        ]);
      } finally {
        hold.release();
        await reading;
      }
    });

    it(`${reader} finishes captured deletion overlap then uses ordinary missing lookup`, async () => {
      const seeded = await seed();
      const { sketch, map } = seeded;
      const checkCapture = captureCount(reader);
      const drainUnheld = retirementObserver();
      const hold = holdArtifact(sketch.table.file, reader, "before artifact", `${reader}`);
      const reading = request(reader, map.id, sketch.table.name);
      try {
        await hold.beforeMutation();
        await cascadeDeleteSketch(testAccountScope(), sketch.table.name);
        await drainUnheld(1);
        expect.soft(await exists(abs(sketch.table.file)), "deleted file survives captured read").toBe(true);
        hold.release();
        await assertCaptured(await reading, reader, seeded);
        checkCapture();
        await retirementsSettled();
        expect(await exists(abs(sketch.table.file))).toBe(false);
        const after = await request(reader, map.id, sketch.table.name);
        if (reader === "summary") {
          expect(after.status).toBe(200);
          const body = await after.json();
          expect(body).toHaveLength(1);
          expect(body[0].tableId).toBe(seeded.other.table.id);
        } else {
          expect(after.status).toBe(404);
          expect(await after.json()).toMatchObject({ error: { code: "not_found" } });
        }
      } finally {
        hold.release();
        await reading;
      }
    });

    for (const damage of ["missing", "corrupt"] as const) {
      it(`${reader} returns internal 500 for a still-current ${damage} artifact with one capture`, async () => {
        const { sketch, map } = await seed();
        const checkCapture = captureCount(reader);
        if (damage === "missing") await rm(abs(sketch.table.file));
        else await writeFile(abs(sketch.table.file), "not a parquet artifact");
        const response = await request(reader, map.id, sketch.table.name);
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ error: {
          code: "internal", message: "An unexpected server error occurred.",
        } });
        checkCapture();
        expect(tables.getOwnedTableByName(testAccountScope(), sketch.table.name)?.file).toBe(sketch.table.file);
        // A rejected reader must release tracking, too: cascade can retire it.
        await cascadeDeleteSketch(testAccountScope(), sketch.table.name);
        await retirementsSettled();
        expect(await exists(abs(sketch.table.file))).toBe(false);
      });
    }
  }
});
