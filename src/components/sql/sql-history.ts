/**
 * Run history: per-browser, every completed run — succeeded or failed,
 * never cancelled — as the exact SQL that ran. Identical SQL collapses to
 * its newest run, so the list is a list of queries rather than of presses;
 * the newest 40 distinct runs are kept. Pure; the component renders what
 * these functions decide.
 */

export interface HistoryEntry {
  id: string;
  /** The exact text that ran — a selected fragment, not its draft. */
  sql: string;
  /** ISO timestamp of the run. */
  at: string;
  ok: boolean;
  rows: number;
  ms: number;
  /** The failure code when `ok` is false. */
  code: string | null;
  /** Table names recognized in the SQL, for the card's title. */
  tables: string[];
}

export const HISTORY_CAP = 40;

/** Read a stored list back defensively — storage is validated and
 * optional: a non-array, or an entry missing any field the
 * cards read, is dropped rather than trusted. */
export function validateHistory(raw: unknown): HistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: HistoryEntry[] = [];
  for (const h of raw) {
    if (!h || typeof h !== "object") continue;
    const e = h as Record<string, unknown>;
    if (
      typeof e.id !== "string" ||
      typeof e.sql !== "string" ||
      typeof e.at !== "string" ||
      typeof e.ok !== "boolean" ||
      typeof e.rows !== "number" ||
      typeof e.ms !== "number" ||
      !(e.code === null || typeof e.code === "string") ||
      !Array.isArray(e.tables) ||
      !e.tables.every((t) => typeof t === "string")
    ) {
      continue;
    }
    out.push({
      id: e.id,
      sql: e.sql,
      at: e.at,
      ok: e.ok,
      rows: e.rows,
      ms: e.ms,
      code: e.code as string | null,
      tables: e.tables as string[],
    });
  }
  return out.slice(0, HISTORY_CAP);
}

export function sameSql(a: string, b: string): boolean {
  return a.trim() === b.trim();
}

/** Add a run: identical SQL collapses to this newest run; the cap holds. */
export function addRun(
  list: readonly HistoryEntry[],
  entry: HistoryEntry,
  cap = HISTORY_CAP,
): HistoryEntry[] {
  const rest = list.filter((h) => !sameSql(h.sql, entry.sql));
  return [entry, ...rest].slice(0, cap);
}

export function removeRun(
  list: readonly HistoryEntry[],
  id: string,
): HistoryEntry[] {
  return list.filter((h) => h.id !== id);
}

/** The card's title: the recognized tables, or "Query". */
export function titleOf(entry: Pick<HistoryEntry, "tables">): string {
  const t = entry.tables;
  if (!t.length) return "Query";
  return (
    t.slice(0, 2).join(" + ") + (t.length > 2 ? ` + ${t.length - 2} more` : "")
  );
}

/** Whether the card clamps the SQL and offers Show all. */
export function isLong(sql: string): boolean {
  const s = sql.trim();
  return s.split("\n").length > 3 || s.length > 150;
}

function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface HistoryGroup {
  label: string;
  entries: HistoryEntry[];
}

/** Group newest-first entries by calendar day: Today, Yesterday, then the
 * date. `now` is injectable for tests. */
export function groupByDay(
  list: readonly HistoryEntry[],
  now: Date = new Date(),
): HistoryGroup[] {
  const today = dayKey(now.toISOString());
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  const yesterday = dayKey(y.toISOString());
  const groups: HistoryGroup[] = [];
  for (const e of list) {
    const k = dayKey(e.at);
    const label = k === today ? "Today" : k === yesterday ? "Yesterday" : k;
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.entries.push(e);
    else groups.push({ label, entries: [e] });
  }
  return groups;
}

/** A clock-ish time for the card (local, 24h). */
export function timeOf(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
