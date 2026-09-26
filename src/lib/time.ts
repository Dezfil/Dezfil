/**
 * Temporal values on the client. Dezfil's convention: timestamps are naive
 * — stored, filtered, and displayed as-is — and math happens in UTC so no
 * viewer's locale shifts the data. Two serialized shapes reach the client:
 * DuckDB's JSON path writes "2021-03-01 08:30:00" (inline renders,
 * previews), GDAL's GeoJSON writer emits RFC 3339 "2021-03-01T08:30:00"
 * (tile features). Both parse here.
 */

/** A time window in epoch milliseconds; null = open-ended on that side. */
export type TimeWindowMs = [number | null, number | null];

/** What an unparseable or missing time value maps to: the far edge of
 * representable time, outside every real window — matching SQL, where NULL
 * fails any comparison and filters out. */
export const NULL_TIME_MS = -8_640_000_000_000_000;

/** Open-ended window bounds. Kept well inside NULL_TIME_MS so a null value
 * stays excluded even from a fully open window. */
export const OPEN_START_MS = -4_000_000_000_000_000;
export const OPEN_END_MS = 4_000_000_000_000_000;

const TIME_VALUE =
  /^(\d{4})-(\d{2})-(\d{2})([T ](\d{2}):(\d{2})(:(\d{2})(\.(\d+))?)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/;

/** Parse a serialized temporal value to epoch ms (UTC for naive values);
 * NULL_TIME_MS when it does not parse. */
export function timeToMs(value: unknown): number {
  if (typeof value !== "string") return NULL_TIME_MS;
  const s = value.trim().replace(/\//g, "-");
  const m = TIME_VALUE.exec(s);
  if (!m) return NULL_TIME_MS;
  if (m[11]) {
    // An explicit offset: let the engine apply it. DuckDB serializes
    // TIMESTAMPTZ with a bare hour offset ("2024-01-01 08:30:00+00"),
    // which Date.parse does not reliably accept — widen it to ±HH:00.
    const iso = s.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : NULL_TIME_MS;
  }
  const ms = m[10] ? Math.round(Number(`0.${m[10]}`) * 1000) : 0;
  const t = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[5] ?? 0),
    Number(m[6] ?? 0),
    Number(m[8] ?? 0),
    ms,
  );
  return Number.isFinite(t) ? t : NULL_TIME_MS;
}

/** A window as the GPU filter range consumes it — open ends widened to the
 * representable edges. Server parity: a fully open window mirrors the SQL
 * no-op filter (TRUE) and keeps null values; any real bound excludes them,
 * exactly like NULL failing the SQL comparison. */
export function windowToRange(win: TimeWindowMs): [number, number] {
  if (win[0] === null && win[1] === null) return [NULL_TIME_MS, OPEN_END_MS];
  return [win[0] ?? OPEN_START_MS, win[1] ?? OPEN_END_MS];
}

/** Epoch ms back to the ISO shape filters store (naive, UTC, seconds). */
export function msToBound(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19);
}

// human labels ----

export type TimeGranularity = "date" | "datetime" | "time";

const DAY_MS = 86_400_000;

/** Label granularity from the span being described: clock time within a
 * day, dates once months apart, both in between. */
export function timeGranularity(spanMs: number): TimeGranularity {
  if (spanMs <= DAY_MS) return "time";
  if (spanMs >= 270 * DAY_MS) return "date";
  return "datetime";
}

// Fixed English month names: labels stay deterministic across machines —
// the same reason the values themselves stay naive/UTC.
// prettier-ignore
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (n: number) => String(n).padStart(2, "0");

/** A human label for an instant, at the given granularity, in UTC. */
export function formatTimeMs(ms: number, granularity: TimeGranularity): string {
  const d = new Date(ms);
  const date = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  if (granularity === "date") return date;
  if (granularity === "time") return `${hm}:${pad(d.getUTCSeconds())}`;
  return `${date} ${hm}`;
}
