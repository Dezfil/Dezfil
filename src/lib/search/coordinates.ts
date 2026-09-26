import type { CoordinateRow } from "./contract";

/**
 * Pasted-coordinate recognition. V1 reads decimal pairs — "52.5, 13.4"
 * — and offers every plausible reading rather than guessing silently:
 * when both lat, lon and lon, lat are valid, both rows appear; when
 * they collapse to the same point, one does. Browser-safe: no server
 * imports.
 */

/** Two signed decimals, comma- or whitespace-separated, nothing else. */
const PAIR = /^\s*([+-]?\d{1,3}(?:\.\d+)?)\s*(?:,\s*|\s+)([+-]?\d{1,3}(?:\.\d+)?)\s*$/;

function validLat(n: number): boolean {
  return Number.isFinite(n) && Math.abs(n) <= 90;
}

function validLng(n: number): boolean {
  return Number.isFinite(n) && Math.abs(n) <= 180;
}

/** The readings of a pasted pair, in the order the user wrote it:
 * first-as-latitude first. */
export function parseCoordinates(text: string): CoordinateRow[] {
  const m = PAIR.exec(text);
  if (!m) return [];
  const a = Number(m[1]);
  const b = Number(m[2]);
  const rows: CoordinateRow[] = [];
  if (validLat(a) && validLng(b)) {
    rows.push({ reading: "latlon", lat: a, lng: b });
  }
  if (validLng(a) && validLat(b)) {
    // The transposed reading is the same point exactly when a === b —
    // one row then, not two identical ones.
    if (!(rows.length && a === b)) {
      rows.push({ reading: "lonlat", lat: b, lng: a });
    }
  }
  return rows;
}
