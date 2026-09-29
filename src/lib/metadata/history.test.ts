import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Database } from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { open } from "./db";
import { insertMap, type MapRecord } from "./maps";
import {
  recordStep,
  undoSteps,
  redoSteps,
  setHistoryCursor,
  historyAvailability,
  stableJson,
  HISTORY_CAP,
  COALESCE_MS,
} from "./history";

/**
 * The undo/redo timeline: linear history with a cursor, coalescing of
 * rapid same-shape writes, group steps, and the cap.
 */

function makeMap(id: string, db: Database): void {
  const now = new Date().toISOString();
  const m: MapRecord = {
    id,
    name: "Test map",
    viewport: { lng: 0, lat: 20, zoom: 1.4 },
    basemap: null,
    customBasemap: null,
    basemapLayers: null,
    note: null,
    legendCorner: null,
    legendOrder: null,
    timeline: null,
    widgets: [],
    widgetsPublished: true,
    publishToken: null,
    publishedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  insertMap(testAccountScope(db), m, db);
}

function nameStep(mapId: string, from: string, to: string, at: number) {
  return {
    mapId,
    scope: "map" as const,
    targetId: mapId,
    op: "update" as const,
    before: { name: from },
    after: { name: to },
    at,
  };
}

describe("map history", () => {
  let dir: string;
  let db: Database;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "dezfil-history-"));
    db = open(path.join(dir, "metadata.sqlite"));
    makeMap("m1", db);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("records a step and reports availability", () => {
    expect(historyAvailability("m1", db)).toEqual({
      canUndo: false,
      canRedo: false,
    });
    recordStep(nameStep("m1", "A", "B", 0), db);
    expect(historyAvailability("m1", db)).toEqual({
      canUndo: true,
      canRedo: false,
    });
    const [step] = undoSteps("m1", db);
    expect(step.before).toEqual({ name: "A" });
    expect(step.after).toEqual({ name: "B" });
    expect(step.op).toBe("update");
  });

  it("moving the cursor flips undo into redo and back", () => {
    recordStep(nameStep("m1", "A", "B", 0), db);
    const [step] = undoSteps("m1", db);
    setHistoryCursor("m1", step.seq - 1, db);
    expect(historyAvailability("m1", db)).toEqual({
      canUndo: false,
      canRedo: true,
    });
    const [redo] = redoSteps("m1", db);
    expect(redo.seq).toBe(step.seq);
    setHistoryCursor("m1", redo.seq, db);
    expect(historyAvailability("m1", db)).toEqual({
      canUndo: true,
      canRedo: false,
    });
  });

  it("a new step discards the redo branch (linear history)", () => {
    recordStep(nameStep("m1", "A", "B", 0), db);
    const [step] = undoSteps("m1", db);
    setHistoryCursor("m1", step.seq - 1, db);
    recordStep(nameStep("m1", "A", "C", COALESCE_MS + 1000), db);
    const state = historyAvailability("m1", db);
    expect(state).toEqual({ canUndo: true, canRedo: false });
    const [top] = undoSteps("m1", db);
    expect(top.after).toEqual({ name: "C" });
  });

  it("rapid same-shape writes coalesce into one trailing step", () => {
    // Three drag ticks, each within the window of the previous — trailing,
    // so the whole drag is one step from first before to last after.
    recordStep(nameStep("m1", "A", "B", 0), db);
    recordStep(nameStep("m1", "B", "C", COALESCE_MS - 1000), db);
    recordStep(nameStep("m1", "C", "D", 2 * (COALESCE_MS - 1000)), db);
    const steps = undoSteps("m1", db);
    expect(steps).toHaveLength(1);
    expect(steps[0].before).toEqual({ name: "A" });
    expect(steps[0].after).toEqual({ name: "D" });
    setHistoryCursor("m1", steps[0].seq - 1, db);
    expect(historyAvailability("m1", db).canUndo).toBe(false);
  });

  it("does not coalesce beyond the window, across field shapes, or across targets", () => {
    recordStep(nameStep("m1", "A", "B", 0), db);
    recordStep(nameStep("m1", "B", "C", COALESCE_MS + 1), db); // too late
    recordStep(
      {
        mapId: "m1",
        scope: "map",
        targetId: "m1",
        op: "update",
        before: { name: "C", basemap: null },
        after: { name: "D", basemap: "dark" },
        at: COALESCE_MS + 2,
      },
      db,
    ); // different field shape
    recordStep(
      {
        mapId: "m1",
        scope: "layer",
        targetId: "l1",
        op: "update",
        before: { name: "x" },
        after: { name: "y" },
        at: COALESCE_MS + 3,
      },
      db,
    ); // different target
    const seqs: number[] = [];
    for (;;) {
      const steps = undoSteps("m1", db);
      if (steps.length === 0) break;
      seqs.push(steps[0].seq);
      setHistoryCursor("m1", steps[0].seq - 1, db);
    }
    expect(seqs).toHaveLength(4);
  });

  it("never coalesces across an undo boundary", () => {
    recordStep(nameStep("m1", "A", "B", 0), db);
    recordStep(nameStep("m1", "B", "C", COALESCE_MS + 1000), db); // separate step
    const [top] = undoSteps("m1", db);
    setHistoryCursor("m1", top.seq - 1, db); // undo B→C; cursor on A→B
    // New write within A→B's window shape-matches it, but the user just
    // undid to B — merging would erase B from the timeline.
    recordStep(nameStep("m1", "B", "Z", COALESCE_MS + 1500), db);
    const steps = undoSteps("m1", db);
    expect(steps[0].after).toEqual({ name: "Z" });
    setHistoryCursor("m1", steps[0].seq - 1, db);
    const [prev] = undoSteps("m1", db);
    expect(prev.after).toEqual({ name: "B" }); // A→B survived intact
  });

  it("contiguous same-group steps undo and redo as one", () => {
    const g = "turn-1";
    recordStep(nameStep("m1", "A", "B", 0), db); // manual, before the group
    recordStep({ ...nameStep("m1", "B", "C", 60_000), groupId: g }, db);
    recordStep(
      {
        mapId: "m1",
        scope: "layer",
        targetId: "l1",
        op: "update",
        before: { visible: true },
        after: { visible: false },
        groupId: g,
        at: 61_000,
      },
      db,
    );
    const steps = undoSteps("m1", db);
    expect(steps).toHaveLength(2); // the group, newest first
    expect(steps[0].targetId).toBe("l1");
    expect(steps[1].after).toEqual({ name: "C" });
    setHistoryCursor("m1", steps[1].seq - 1, db);
    expect(undoSteps("m1", db)).toHaveLength(1); // the manual step alone
    const redo = redoSteps("m1", db);
    expect(redo).toHaveLength(2); // oldest first
    expect(redo[0].after).toEqual({ name: "C" });
  });

  it("grouped writes do not merge into ungrouped neighbors", () => {
    recordStep(nameStep("m1", "A", "B", 0), db);
    recordStep({ ...nameStep("m1", "B", "C", 100), groupId: "g" }, db);
    const steps = undoSteps("m1", db);
    expect(steps).toHaveLength(1);
    expect(steps[0].groupId).toBe("g");
    setHistoryCursor("m1", steps[0].seq - 1, db);
    expect(undoSteps("m1", db)[0].groupId).toBeNull();
  });

  it("caps the timeline and prunes the oldest steps", () => {
    for (let i = 0; i < HISTORY_CAP + 5; i++) {
      recordStep(
        nameStep("m1", `v${i}`, `v${i + 1}`, i * (COALESCE_MS + 1)),
        db,
      );
    }
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM map_history WHERE map_id = 'm1'`)
      .get() as { n: number };
    expect(count.n).toBe(HISTORY_CAP);
    expect(historyAvailability("m1", db).canUndo).toBe(true);
    const [top] = undoSteps("m1", db);
    expect(top.after).toEqual({ name: `v${HISTORY_CAP + 5}` });
  });

  it("deleting the map cascades its history", () => {
    recordStep(nameStep("m1", "A", "B", 0), db);
    db.prepare(`DELETE FROM maps WHERE id = 'm1'`).run();
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM map_history`)
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("stableJson compares equal regardless of key order", () => {
    expect(stableJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 3 } })).toBe(
      stableJson({ a: { c: 3, d: [2, { y: 2, z: 1 }] }, b: 1 }),
    );
    expect(stableJson([1, 2])).not.toBe(stableJson([2, 1]));
  });
});
