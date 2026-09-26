import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import { metadataDb } from "./db";

/**
 * User-saved custom palettes: instance-global ramps that appear in every
 * map's picker beside the curated catalogue. Styles reference them by name
 * but bake resolved colors in at classification time, so deleting a palette
 * never breaks a map that used it.
 */

export interface CustomPaletteStop {
  /** #rrggbb */
  color: string;
  /** 0–1, non-decreasing across the stops. */
  position: number;
}

export interface CustomPalette {
  /** Stable id stored in styles — never collides with catalogue names. */
  name: string;
  label: string;
  stops: CustomPaletteStop[];
}

const MAX_STOPS = 16;
const MAX_LABEL = 60;

/** Why a palette payload is invalid, in one sentence — or null when fine. */
export function customPaletteProblem(value: unknown): string | null {
  if (!value || typeof value !== "object")
    return "Expected a palette object.";
  const p = value as Record<string, unknown>;
  if (
    typeof p.label !== "string" ||
    p.label.trim().length === 0 ||
    p.label.trim().length > MAX_LABEL
  )
    return `label must be 1 to ${MAX_LABEL} characters.`;
  if (!Array.isArray(p.stops) || p.stops.length < 2 || p.stops.length > MAX_STOPS)
    return `stops must be 2 to ${MAX_STOPS} entries.`;
  let prev = -1;
  for (const s of p.stops) {
    const stop = s as Record<string, unknown>;
    if (!stop || typeof stop !== "object")
      return "Each stop must be an object.";
    if (
      typeof stop.color !== "string" ||
      !/^#[0-9a-fA-F]{6}$/.test(stop.color)
    )
      return "Each stop color must be a #rrggbb hex value.";
    if (
      typeof stop.position !== "number" ||
      !Number.isFinite(stop.position) ||
      stop.position < 0 ||
      stop.position > 1
    )
      return "Each stop position must be a number between 0 and 1.";
    if (stop.position < prev)
      return "Stop positions must not decrease.";
    prev = stop.position;
  }
  return null;
}

interface Row {
  name: string;
  label: string;
  stops: string;
}

function fromRow(row: Row): CustomPalette {
  return {
    name: row.name,
    label: row.label,
    stops: JSON.parse(row.stops) as CustomPaletteStop[],
  };
}

export function listCustomPalettes(
  db: Database = metadataDb(),
): CustomPalette[] {
  const rows = db
    .prepare(
      `SELECT name, label, stops FROM custom_palettes ORDER BY created_at`,
    )
    .all() as Row[];
  return rows.map(fromRow);
}

export function getCustomPalette(
  name: string,
  db: Database = metadataDb(),
): CustomPalette | null {
  const row = db
    .prepare(`SELECT name, label, stops FROM custom_palettes WHERE name = ?`)
    .get(name) as Row | undefined;
  return row ? fromRow(row) : null;
}

/** Persist a validated palette; the caller has already run
 * customPaletteProblem. Stops are stored sorted by position. */
export function createCustomPalette(
  input: { label: string; stops: CustomPaletteStop[] },
  db: Database = metadataDb(),
): CustomPalette {
  const name = `custom-${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const stops = [...input.stops]
    .sort((a, b) => a.position - b.position)
    .map((s) => ({ color: s.color.toLowerCase(), position: s.position }));
  db.prepare(
    `INSERT INTO custom_palettes (name, label, stops, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(name, input.label.trim(), JSON.stringify(stops), now, now);
  return { name, label: input.label.trim(), stops };
}

export function deleteCustomPalette(
  name: string,
  db: Database = metadataDb(),
): boolean {
  const info = db
    .prepare(`DELETE FROM custom_palettes WHERE name = ?`)
    .run(name);
  return info.changes > 0;
}
