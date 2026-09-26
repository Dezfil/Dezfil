import type { SqlPosition } from "../sql-editor-extensions";

/**
 * The error mark's fallback: when a failure carries no position the
 * server could map, but its message names an identifier — a missing
 * table, column or function, or the token a syntax error stopped at — and
 * that identifier occurs exactly once in the draft, mark that occurrence.
 * Twice or never: no mark, rather than a wrong one. Pure.
 */
const NAMERS: readonly RegExp[] = [
  /with name "?([A-Za-z_][\w.]*)"? does not exist/i,
  /Referenced column "([^"]+)" not found/i,
  /syntax error at or near "([^"]+)"/i,
  /Referenced table "([^"]+)" not found/i,
];

export function namedIdentifier(message: string): string | null {
  for (const re of NAMERS) {
    const m = re.exec(message);
    if (m) return m[1];
  }
  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function locateNamed(sql: string, message: string): SqlPosition | null {
  const token = namedIdentifier(message);
  if (!token) return null;
  const bare = token.includes(".") ? token.split(".").pop()! : token;
  const re = new RegExp(`(^|[^\\w])(${escapeRe(bare)})(?![\\w])`, "gi");
  const hits: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    hits.push(m.index + m[1].length);
    if (hits.length > 1) break;
  }
  if (hits.length !== 1) return null;
  const at = hits[0];
  const before = sql.slice(0, at);
  return {
    line: before.split("\n").length,
    column: at - (before.lastIndexOf("\n") + 1) + 1,
  };
}
