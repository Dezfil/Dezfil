import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import { metadataDb } from "./db";

/**
 * Per-map undo/redo timeline. Each step records the changed fields' before-
 * and after-images exactly as stored — the services capture them around
 * their writes; applying a step writes an image back verbatim. The map's
 * cursor is the seq of the newest applied step; steps above it are
 * redoable, and a new step discards them first (linear history).
 */

export type HistoryScope = "map" | "layer";
export type HistoryOp = "update" | "add" | "delete";

/** Field-name → recorded value. Whole-value per field, like the writes. */
export type HistoryImage = Record<string, unknown>;

export interface HistoryStep {
  authorId: string | null;
  id: string;
  mapId: string;
  seq: number;
  scope: HistoryScope;
  targetId: string;
  op: HistoryOp;
  /** The changed fields as stored before the step; null for an add. */
  before: HistoryImage | null;
  /** The changed fields as stored after the step; null for a delete. */
  after: HistoryImage | null;
  /** Steps sharing a group undo/redo as one (an assistant turn). */
  groupId: string | null;
  createdAt: string;
}

export interface HistoryAvailability {
  canUndo: boolean;
  canRedo: boolean;
}

/** Timeline depth per map; the oldest steps fall off. */
export const HISTORY_CAP = 100;

/** Rapid same-shape writes within this window collapse into one step —
 * a slider drag is one PATCH per input event. Trailing: each merge
 * restarts the window, so a long drag stays a single step. */
export const COALESCE_MS = 3000;

interface StepRow {
  author_id: string | null;
  id: string;
  map_id: string;
  seq: number;
  scope: string;
  target_id: string;
  op: string;
  before: string | null;
  after: string | null;
  group_id: string | null;
  created_at: string;
}

function stepFromRow(r: StepRow): HistoryStep {
  return {
    authorId: r.author_id,
    id: r.id,
    mapId: r.map_id,
    seq: r.seq,
    scope: r.scope as HistoryScope,
    targetId: r.target_id,
    op: r.op as HistoryOp,
    before: r.before ? (JSON.parse(r.before) as HistoryImage) : null,
    after: r.after ? (JSON.parse(r.after) as HistoryImage) : null,
    groupId: r.group_id,
    createdAt: r.created_at,
  };
}

/** JSON with object keys sorted at every depth — image comparisons must
 * not depend on construction order. */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .sort()
        .map((k) => [k, sortValue(o[k])]),
    );
  }
  return v;
}

/**
 * Before/after images over the given keys, keeping only fields whose stored
 * value actually changed — a write that changes nothing records nothing.
 */
export function diffImages(
  prior: Record<string, unknown>,
  fresh: Record<string, unknown>,
  keys: string[],
): { before: HistoryImage; after: HistoryImage } | null {
  const before: HistoryImage = {};
  const after: HistoryImage = {};
  let changed = false;
  for (const k of keys) {
    const was = prior[k] ?? null;
    const now = fresh[k] ?? null;
    if (stableJson(was) !== stableJson(now)) {
      before[k] = was;
      after[k] = now;
      changed = true;
    }
  }
  return changed ? { before, after } : null;
}

function cursorOf(mapId: string, db: Database): number {
  const row = db
    .prepare(`SELECT history_cursor AS c FROM maps WHERE id = ?`)
    .get(mapId) as { c: number } | undefined;
  if (!row) throw new Error(`unknown map: ${mapId}`);
  return row.c;
}

function sameKeys(a: HistoryImage | null, b: HistoryImage | null): boolean {
  const ka = Object.keys(a ?? {}).sort();
  const kb = Object.keys(b ?? {}).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
}

/**
 * Append a step: discard the redo branch, then either coalesce into the
 * newest step (same shape, within the window) or insert above the cursor;
 * prune past the cap. The caller decides *whether* a change is recorded
 * (no-op writes and unrecorded fields never reach here).
 */
export function recordStep(
  input: {
    mapId: string;
    scope: HistoryScope;
    targetId: string;
    op: HistoryOp;
    before: HistoryImage | null;
    after: HistoryImage | null;
    groupId?: string | null;
    /** Clock override for the coalescing window — tests only. */
    at?: number;
  },
  db: Database = metadataDb(),
  actor?: AccountScope,
): void {
  const authorId = actor ? requireAccountScope(actor, db) : null;
  const now = input.at ?? Date.now();
  const groupId = input.groupId ?? null;
  db.transaction(() => {
    const cursor = cursorOf(input.mapId, db);
    // A discarded redo branch marks an undo boundary — the step now at the
    // cursor is one the user deliberately returned to; never merge into it.
    const hadRedo =
      db
        .prepare(
          `SELECT 1 FROM map_history WHERE map_id = ? AND seq > ? LIMIT 1`,
        )
        .get(input.mapId, cursor) !== undefined;
    db.prepare(`DELETE FROM map_history WHERE map_id = ? AND seq > ?`).run(
      input.mapId,
      cursor,
    );

    const top = db
      .prepare(`SELECT * FROM map_history WHERE map_id = ? AND seq = ?`)
      .get(input.mapId, cursor) as StepRow | undefined;
    const merge =
      !hadRedo &&
      top &&
      top.op === "update" &&
      input.op === "update" &&
      top.scope === input.scope &&
      top.target_id === input.targetId &&
      top.group_id === groupId &&
      top.author_id === authorId &&
      sameKeys(
        top.before ? (JSON.parse(top.before) as HistoryImage) : null,
        input.before,
      ) &&
      now - Date.parse(top.created_at) <= COALESCE_MS;
    if (merge) {
      db.prepare(
        `UPDATE map_history SET after = ?, created_at = ? WHERE id = ?`,
      ).run(
        input.after ? JSON.stringify(input.after) : null,
        new Date(now).toISOString(),
        top.id,
      );
      return;
    }

    const seq = cursor + 1;
    db.prepare(
      `INSERT INTO map_history
         (id, map_id, seq, scope, target_id, op, before, after, group_id, created_at, author_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      input.mapId,
      seq,
      input.scope,
      input.targetId,
      input.op,
      input.before ? JSON.stringify(input.before) : null,
      input.after ? JSON.stringify(input.after) : null,
      groupId,
      new Date(now).toISOString(),
      authorId,
    );
    db.prepare(`UPDATE maps SET history_cursor = ? WHERE id = ?`).run(
      seq,
      input.mapId,
    );
    db.prepare(`DELETE FROM map_history WHERE map_id = ? AND seq <= ?`).run(
      input.mapId,
      seq - HISTORY_CAP,
    );
  })();
}

/**
 * The steps one undo reverts, newest first: the step at the cursor plus,
 * when it carries a group, the contiguous steps below sharing it.
 */
export function undoSteps(
  mapId: string,
  db: Database = metadataDb(),
): HistoryStep[] {
  const cursor = cursorOf(mapId, db);
  const rows = db
    .prepare(
      `SELECT * FROM map_history WHERE map_id = ? AND seq <= ?
       ORDER BY seq DESC LIMIT ?`,
    )
    .all(mapId, cursor, HISTORY_CAP) as StepRow[];
  return takeGroup(rows);
}

/**
 * The steps one redo re-applies, oldest first: the step just above the
 * cursor plus, when it carries a group, the contiguous steps above it.
 */
export function redoSteps(
  mapId: string,
  db: Database = metadataDb(),
): HistoryStep[] {
  const cursor = cursorOf(mapId, db);
  const rows = db
    .prepare(
      `SELECT * FROM map_history WHERE map_id = ? AND seq > ?
       ORDER BY seq ASC LIMIT ?`,
    )
    .all(mapId, cursor, HISTORY_CAP) as StepRow[];
  return takeGroup(rows);
}

function takeGroup(rows: StepRow[]): HistoryStep[] {
  if (rows.length === 0) return [];
  const steps = [rows[0]];
  if (rows[0].group_id) {
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].group_id !== rows[0].group_id || rows[i].author_id !== rows[0].author_id ||
        Math.abs(rows[i].seq - rows[i - 1].seq) !== 1) break;
      steps.push(rows[i]);
    }
  }
  return steps.map(stepFromRow);
}

/** Move the cursor after applying steps: below them (undo) or onto the
 * last of them (redo). */
export function setHistoryCursor(
  mapId: string,
  seq: number,
  db: Database = metadataDb(),
): void {
  db.prepare(`UPDATE maps SET history_cursor = ? WHERE id = ?`).run(seq, mapId);
}

/**
 * Remove every step that targeted one layer (the sketch cascade is not
 * undoable — owner-targeting steps leave the timeline so replay can
 * neither restore nor error on destroyed state). Availability and
 * traversal compare by seq value, so a cursor left pointing into a
 * purged gap stays coherent; unrelated steps survive untouched.
 */
export function purgeTargetSteps(
  mapId: string,
  targetId: string,
  db: Database = metadataDb(),
): void {
  db.prepare(
    `DELETE FROM map_history
     WHERE map_id = ? AND scope = 'layer' AND target_id = ?`,
  ).run(mapId, targetId);
}

/**
 * Remove every step whose recorded images reference an id (review): a
 * map-scoped widget image that still names a cascaded owner would, on
 * redo, resurrect an orphan bound to destroyed state. The id is a UUID,
 * so a substring match cannot collide with unrelated data. Deliberately
 * coarse — a step that carries the destroyed owner is not "unrelated
 * history", and dropping it is what keeps replay unable to restore or
 * target what no longer exists.
 */
export function purgeStepsReferencing(
  mapId: string,
  id: string,
  db: Database = metadataDb(),
): void {
  db.prepare(
    `DELETE FROM map_history
     WHERE map_id = ? AND (before LIKE ? OR after LIKE ?)`,
  ).run(mapId, `%${id}%`, `%${id}%`);
}

export function historyAvailability(
  mapId: string,
  db: Database = metadataDb(),
): HistoryAvailability {
  const cursor = cursorOf(mapId, db);
  const under = db
    .prepare(
      `SELECT 1 FROM map_history WHERE map_id = ? AND seq <= ? LIMIT 1`,
    )
    .get(mapId, cursor);
  const over = db
    .prepare(`SELECT 1 FROM map_history WHERE map_id = ? AND seq > ? LIMIT 1`)
    .get(mapId, cursor);
  return { canUndo: under !== undefined, canRedo: over !== undefined };
}
