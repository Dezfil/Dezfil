import type { TableListing } from "../../api";
import type { QueryResult } from "../../query-types";

/** Case-insensitive substring filter over table names.
 * The listing's server order — newest tables first — is preserved; this
 * never re-sorts. */
export function filterTables(
  tables: TableListing[],
  query: string,
): TableListing[] {
  const q = query.trim().toLowerCase();
  if (q === "") return tables;
  return tables.filter((t) => t.name.toLowerCase().includes(q));
}

/** The name-follow rule (spec decision 3, the panel's behavior kept):
 * the automatic name tracks the picked table only while the field is
 * blank or still equal to the previous automatic value — a name the
 * user edited survives every later pick. */
export function followName(
  current: string,
  previousAuto: string | null,
  pickedTable: string,
): string {
  return current === "" || current === previousAuto ? pickedTable : current;
}

/**
 * A dataset as the map's SQL types it: a dataset of the map's SQL home by
 * its plain name, anyone else's with their SQL name, `<sql name>.<name>`,
 * one's own included when the map is someone else's. Without a known home
 * (no map), as the reader's own console types it.
 */
export function typedInHome(
  t: { name: string; qualifiedName: string; owner?: { sqlName: string } },
  home: string | null,
): string {
  if (home === null) return t.qualifiedName;
  return t.owner && t.owner.sqlName !== home ? `${t.owner.sqlName}.${t.name}` : t.name;
}

/**
 * The one line under the catalogue's scope on a map whose SQL home is
 * someone else's: one's own datasets carry one's SQL name there, which is
 * the surprise it names, with one of them as it is typed. Nothing on one's
 * own map.
 */
export function homeLine(
  home: string | null,
  owner: { name: string; sqlName: string } | null,
  me: string | null,
  offered: readonly { name: string; owner?: { sqlName: string } }[],
): { lead: string; example: string } | null {
  if (home === null || me === null || home === me) return null;
  const mine = offered.find((t) => t.owner?.sqlName === me);
  const example = mine ? `${me}.${mine.name}` : me;
  const whose = owner && owner.sqlName === home ? `This map is ${owner.name.trim().split(/\s+/)[0]}’s` : `This map reads ${home}’s datasets`;
  return { lead: `${whose}, so your own datasets carry your SQL name:`, example };
}

/** The SQL a table pick compiles to — one definition, shared by the
 * create call, the footer disclosure, and the table-to-SQL carry, so
 * the stated query and the stored query cannot drift. */
export function impliedQuery(table: string): string {
  return `SELECT * FROM ${table}`;
}

/** The preview's request: the SQL as typed, evaluated in the map's SQL
 * home (the context the saved layer is read in), so the layer saved is the
 * query that was previewed, whoever's map it is. */
export function previewRequest(sql: string, mapId?: string): { sql: string; writtenIn?: { kind: "map"; id: string } } {
  return mapId ? { sql, writtenIn: { kind: "map", id: mapId } } : { sql };
}

/** The table-to-SQL carry (spec decision 4) follows the same ownership
 * rule as the name: seed only while the draft is blank or still a
 * previous automatic seed — never over the user's own SQL. */
export function followSeed(
  draft: string,
  previousSeed: string | null,
  pickedTable: string | null,
): string {
  if (pickedTable === null) return draft;
  return draft === "" || draft === previousSeed
    ? impliedQuery(pickedTable)
    : draft;
}

/* ---------------- preview fencing (spec decisions 5/7) ---------------- */

export interface PreviewSettled {
  seq: number;
  /** The exact text that ran — currency is judged against this. */
  sql: string;
  result: QueryResult | null;
  error: string | null;
  ms: number | null;
}

export interface PreviewState {
  /** Last issued run id; anything settling under an older id is stale. */
  seq: number;
  running: boolean;
  settled: PreviewSettled | null;
}

export const IDLE_PREVIEW: PreviewState = {
  seq: 0,
  running: false,
  settled: null,
};

/** Issue a new run: bumps the fence so every earlier in-flight response
 * becomes stale, whatever order the network returns them in. */
export function beginPreview(state: PreviewState): [PreviewState, number] {
  const seq = state.seq + 1;
  return [{ ...state, seq, running: true }, seq];
}

/** Settle a run. A response carrying an old fence is dropped whole —
 * a slower superseded run can never replace a newer result (criterion
 * 11). */
export function settlePreview(
  state: PreviewState,
  settled: PreviewSettled,
): PreviewState {
  if (settled.seq !== state.seq) return state;
  return { seq: state.seq, running: false, settled };
}

/** What the result panel may claim: a settled result is
 * `current` only while the draft still equals the text that ran;
 * editing afterwards demotes it to `stale` — shown, but marked no
 * longer current. */
export function previewCurrency(
  state: PreviewState,
  draft: string,
): "none" | "current" | "stale" {
  if (state.settled === null || state.settled.result === null) {
    return state.settled?.error ? "current" : "none";
  }
  return state.settled.sql === draft ? "current" : "stale";
}
