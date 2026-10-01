/**
 * The draft's ownership rule (narrowed): a snippet replaces the editor
 * only while it is blank or still holds the last automatic seed;
 * anything the user wrote survives, and the snippet lands below it. Open
 * as SQL and the Data Explorer door left the rule in the field round —
 * they replace, through the editor's undoable write. Pure, so the
 * contract is testable apart from the editor.
 */

/** A SQL identifier, quoted the way the engine reads it back (the
 * contract, kept for the insert action). */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Words the engine will not read as a bare identifier. A bounded list of
 * the reserved words a column or table is likely to collide with; a name
 * on it is quoted, a name off it may still be quoted for its shape. */
const RESERVED = new Set(
  (
    "all analyse analyze and any array as asc asymmetric authorization binary both case cast check collate collation column concurrently constraint create cross current_catalog current_date current_role current_schema current_time current_timestamp current_user default deferrable desc describe distinct do else end except false fetch for foreign freeze from full grant group having ilike in initially inner intersect into is isnull join lateral leading left like limit localtime localtimestamp natural not notnull null offset on only or order outer overlaps pivot placing primary qualify references returning right select session_user show similar some summarize symmetric table tablesample then to trailing true union unique unpivot user using variadic verbose when where window with"
  ).split(" "),
);

/** An identifier the engine reads back as itself: bare when it can be,
 * quoted when it must be — uppercase, spaces, punctuation, a leading
 * digit, or a reserved word. */
export function identifierFor(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) && !RESERVED.has(name)
    ? name
    : quoteIdentifier(name);
}

/** A dataset as its reader types it: its plain name, or someone else's
 * `<sql name>.<name>`, each part bare when it can be. A dataset's name never
 * holds a dot, so the one dot a typed name carries is the qualifier's. */
export function tableReference(typed: string): string {
  const dot = typed.indexOf(".");
  return dot < 0
    ? identifierFor(typed)
    : `${identifierFor(typed.slice(0, dot))}.${identifierFor(typed.slice(dot + 1))}`;
}

/** A typed name with every part quoted, the insert action's contract:
 * `"roads"`, or someone else's `"ada"."roads"`. */
export function quotedReference(typed: string): string {
  const dot = typed.indexOf(".");
  return dot < 0
    ? quoteIdentifier(typed)
    : `${quoteIdentifier(typed.slice(0, dot))}.${quoteIdentifier(typed.slice(dot + 1))}`;
}

/** A query returning a table's first 100 rows — the automatic seed. */
export function starterSql(table: string): string {
  return `SELECT *\nFROM ${tableReference(table)}\nLIMIT 100;`;
}

export interface AutomaticWrite {
  /** The editor's new text. */
  text: string;
  /** Whether the seed replaced the editor (true) or was appended (false). */
  replaced: boolean;
  /** Where the automatic statement sits in the new text. */
  from: number;
  to: number;
}

/** Apply an automatic statement to the draft under the ownership rule. */
export function applyAutomatic(
  draft: string,
  lastSeed: string | null,
  statement: string,
): AutomaticWrite {
  if (draft.trim() === "" || draft === lastSeed) {
    return { text: statement, replaced: true, from: 0, to: statement.length };
  }
  const gap = draft.endsWith("\n") ? "\n" : "\n\n";
  const text = draft + gap + statement;
  return {
    text,
    replaced: false,
    from: draft.length + gap.length,
    to: text.length,
  };
}

/** The *edited* mark: the draft has content, came from a seed, and no
 * longer equals it. */
export function isEdited(draft: string, lastSeed: string | null): boolean {
  return draft.trim() !== "" && lastSeed !== null && draft !== lastSeed;
}
