import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { PostgreSQL, sql } from "@codemirror/lang-sql";
import { RangeSet, StateEffect, StateField } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  gutterLineClass,
  tooltips,
  type DecorationSet,
} from "@codemirror/view";

/**
 * The SQL editor's opt-in abilities, kept out of the component so the
 * editor file stays the host-agnostic shell it was: schema-driven
 * completion, an error mark at a position, and the text size and line
 * wrap a host asks for. Every host that does not ask for them gets the
 * editor exactly as before.
 */

/** What completion knows: table names with their columns, and a bounded
 * list of functions worth offering (the spatial ones the snippets use,
 * at least). */
export interface SqlCompletion {
  tables: Record<string, readonly string[]>;
  functions?: readonly string[];
}

/** A 1-based line and column into the document, as the API reports a
 * sql_error's place. */
export interface SqlPosition {
  line: number;
  column: number;
}

/* ---------------------------------------------------------------- */
/* Completion                                                        */
/* ---------------------------------------------------------------- */

const REF_RE = /\b(?:from|join)\s+("?)([A-Za-z_][\w]*)\1(?:\.("?)([A-Za-z_][\w]*)\3)?/gi;

/** Table names the document references after FROM and JOIN — recognized
 * against the known tables, so an alias or a subquery keyword never
 * counts. A known name is the one its reader types: one's own dataset by
 * its plain name, another person's as `<sql name>.<dataset>`, which is how
 * two same-named datasets stay apart. Pure, so the contract is testable
 * apart from the view. */
export function referencedTables(
  doc: string,
  known: readonly string[],
): string[] {
  const set = new Set(known);
  const out: string[] = [];
  let m: RegExpExecArray | null;
  REF_RE.lastIndex = 0;
  while ((m = REF_RE.exec(doc)) !== null) {
    const name = m[4] === undefined ? m[2] : `${m[2]}.${m[4]}`;
    if (set.has(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Completion for the columns of the tables the query already references,
 * offered unqualified — what a person writing a SELECT list or a WHERE
 * clause reaches for. Qualified (`alias.`) positions are the schema
 * source's and are left to it. */
function referencedColumnsSource(tables: SqlCompletion["tables"]) {
  const known = Object.keys(tables);
  return (ctx: CompletionContext): CompletionResult | null => {
    const word = ctx.matchBefore(/[\w]*/);
    if (!word || (word.from === word.to && !ctx.explicit)) return null;
    if (ctx.state.sliceDoc(Math.max(0, word.from - 1), word.from) === ".") {
      return null;
    }
    const refs = referencedTables(ctx.state.doc.toString(), known);
    const options: Completion[] = [];
    for (const t of refs) {
      for (const c of tables[t]) {
        options.push({ label: c, type: "property", detail: t, boost: 2 });
      }
    }
    if (!options.length) return null;
    return { from: word.from, options, validFor: /^\w*$/ };
  };
}

/** Completion for a bounded list of functions. */
function functionsSource(functions: readonly string[]) {
  const options: Completion[] = functions.map((f) => ({
    label: f,
    type: "function",
    detail: "function",
  }));
  return (ctx: CompletionContext): CompletionResult | null => {
    const word = ctx.matchBefore(/[\w]*/);
    if (!word || (word.from === word.to && !ctx.explicit)) return null;
    if (ctx.state.sliceDoc(Math.max(0, word.from - 1), word.from) === ".") {
      return null;
    }
    return { from: word.from, options, validFor: /^\w*$/ };
  };
}

/** The language plus completion for a host that asked for it: the SQL
 * grammar with the schema, keywords completed upper-case, the referenced
 * columns and the function list as extra sources, and the completion
 * UI itself. Without a config, the plain grammar as before. */
export function sqlLanguage(completion: SqlCompletion | null): Extension {
  if (!completion) return sql({ dialect: PostgreSQL });
  const extras: Extension[] = [
    PostgreSQL.language.data.of({
      autocomplete: referencedColumnsSource(completion.tables),
    }),
  ];
  if (completion.functions?.length) {
    extras.push(
      PostgreSQL.language.data.of({
        autocomplete: functionsSource(completion.functions),
      }),
    );
  }
  return [
    sql({
      dialect: PostgreSQL,
      schema: completion.tables as Record<string, string[]>,
      upperCaseKeywords: true,
    }),
    ...extras,
    autocompletion({ icons: false, activateOnTyping: true }),
    // The list mounts on the body, styled by the editor's theme still: the
    // editor card clips its overflow, and a card that blurs what lies
    // behind it is the containing block of its fixed descendants, so a
    // list inside it would be cut at the card's edge.
    typeof document === "undefined" ? [] : tooltips({ parent: document.body }),
  ];
}

/* ---------------------------------------------------------------- */
/* The error mark                                                    */
/* ---------------------------------------------------------------- */

/** Set (or clear, with null) the error mark. The next document change
 * clears it regardless — a mark belongs to the text it was reported on. */
export const setErrorMark = StateEffect.define<SqlPosition | null>();

const errorMark = Decoration.mark({ class: "cm-sqlError" });
const errorLine = Decoration.line({ class: "cm-sqlErrorLine" });

class ErrorGutterMarker extends GutterMarker {
  elementClass = "cm-sqlErrorGutter";
}
const errorGutter = new ErrorGutterMarker();

/** The token at a 1-based position: the identifier-ish run that starts
 * at or contains the column, else the single character there, else the
 * last character of the line. Returns document offsets. */
export function tokenRangeAt(
  doc: { lines: number; line(n: number): { from: number; text: string } },
  at: SqlPosition,
): { from: number; to: number; lineFrom: number } {
  const line = doc.line(Math.min(Math.max(1, at.line), doc.lines));
  const text = line.text;
  const col = Math.min(Math.max(0, at.column - 1), Math.max(0, text.length - 1));
  const isWord = (ch: string) => /[\w"]/.test(ch);
  if (text.length === 0) return { from: line.from, to: line.from, lineFrom: line.from };
  if (!isWord(text[col] ?? "")) {
    // A caret on whitespace or punctuation marks that single glyph.
    return { from: line.from + col, to: line.from + col + 1, lineFrom: line.from };
  }
  let from = col;
  let to = col;
  while (from > 0 && isWord(text[from - 1])) from--;
  while (to < text.length && isWord(text[to])) to++;
  return { from: line.from + from, to: line.from + to, lineFrom: line.from };
}

/** The mark's field, exported for tests; hosts use the extensions. */
export const errorMarkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    if (tr.docChanged) return Decoration.none;
    for (const e of tr.effects) {
      if (e.is(setErrorMark)) {
        if (!e.value) return Decoration.none;
        const r = tokenRangeAt(tr.state.doc, e.value);
        const ranges = [errorLine.range(r.lineFrom)];
        if (r.to > r.from) ranges.push(errorMark.range(r.from, r.to));
        return Decoration.set(ranges, true);
      }
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const errorGutterField = gutterLineClass.compute([errorMarkField], (state) => {
  const deco = state.field(errorMarkField);
  let lineFrom: number | null = null;
  deco.between(0, state.doc.length, (from, _to, value) => {
    if (value.spec.class === "cm-sqlErrorLine") lineFrom = from;
  });
  return lineFrom === null
    ? RangeSet.empty
    : RangeSet.of([errorGutter.range(lineFrom)]);
});

/** The error-mark extensions; inert until an effect sets a position. */
export function errorMarkExtensions(): Extension {
  return [errorMarkField, errorGutterField];
}

/* ---------------------------------------------------------------- */
/* The look a host asks for: text size and line wrap                */
/* ---------------------------------------------------------------- */

/** The editor's text size where its host gives none: every editor but
 * the SQL console's, which opens at the instance's default. */
export const EDITOR_TEXT_SIZE = 12;

/** One theme per size, made once; the editor's own chrome carries none. */
const textSizes = new Map<number, Extension>();
function textSizeTheme(px: number): Extension {
  let theme = textSizes.get(px);
  if (!theme) {
    theme = EditorView.theme({ "&": { fontSize: `${px}px` } });
    textSizes.set(px, theme);
  }
  return theme;
}

/** The text size and line wrap a host asks for: 12 px and unwrapped
 * unless it says otherwise. */
export function editorLook({
  textSize = EDITOR_TEXT_SIZE,
  wrap = false,
}: {
  textSize?: number;
  wrap?: boolean;
}): Extension {
  return [textSizeTheme(textSize), ...(wrap ? [EditorView.lineWrapping] : [])];
}

/* ---------------------------------------------------------------- */
/* The completion list                                               */
/* ---------------------------------------------------------------- */

/** The completion list in the app's own chrome. It is a menu, so it
 * reads the menu role's ground, blur, edge and shadow, as every other menu
 * does: a look that restates the menus restates it too. */
export const completionLook: Extension = EditorView.theme({
  ".cm-tooltip.cm-tooltip-autocomplete": {
    backgroundColor: "var(--surface-menu-fill)",
    backdropFilter: "var(--surface-menu-blur)",
    border: "var(--surface-menu-edge)",
    borderRadius: "10px",
    boxShadow: "var(--surface-menu-shadow)",
    padding: "4px",
    // Completion lists code: the mono face, as the scroller has it.
    font: "12px var(--font-mono)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
    padding: "4px 8px",
    borderRadius: "6px",
    color: "var(--fg)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--accent-dim)",
    color: "var(--fg)",
  },
  ".cm-completionDetail": {
    fontFamily: "var(--font-ui)",
    fontSize: "10.5px",
    color: "var(--fg-faint)",
    marginLeft: "12px",
    fontStyle: "normal",
  },
  ".cm-completionMatchedText": {
    textDecoration: "none",
    color: "var(--accent-bright)",
    fontWeight: "600",
  },
});
