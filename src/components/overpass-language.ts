import { StreamLanguage, type StreamParser } from "@codemirror/language";

/** Overpass QL statement and setting words — enough for honest colors,
 * not a grammar: statements, out modes, and the bracket-setting names
 * the builder emits. Unknown words stay unstyled. */
const KEYWORDS = new Set([
  "node",
  "way",
  "rel",
  "relation",
  "nwr",
  "nw",
  "nr",
  "wr",
  "area",
  "derived",
  "out",
  "is_in",
  "timeout",
  "maxsize",
  "bbox",
  "date",
  "diff",
  "adiff",
  "foreach",
  "for",
  "if",
  "union",
  "poly",
  "around",
  "body",
  "skel",
  "geom",
  "center",
  "meta",
  "tags",
  "ids",
  "count",
  "qt",
  "asc",
  "json",
  "xml",
  "csv",
]);

interface OverpassState {
  inBlockComment: boolean;
}

/** The tokenizer behind the OSM drawer's colors.
 * Exported apart from the language so the tests can drive it with a
 * StringStream directly — no editor needed. Style names are the
 * CodeMirror defaults, so the app's one highlight palette applies. */
export const overpassParser: StreamParser<OverpassState> = {
  name: "overpassql",
  startState: () => ({ inBlockComment: false }),
  token(stream, state) {
    if (state.inBlockComment) {
      if (stream.skipTo("*/")) {
        stream.match("*/");
        state.inBlockComment = false;
      } else {
        stream.skipToEnd();
      }
      return "comment";
    }
    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match("/*")) {
      state.inBlockComment = true;
      if (stream.skipTo("*/")) {
        stream.match("*/");
        state.inBlockComment = false;
      } else {
        stream.skipToEnd();
      }
      return "comment";
    }
    // The template placeholder ({{bbox}}) the drawer documents.
    if (stream.match(/^\{\{[^}]*\}\}/)) return "atom";
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
    if (stream.match(/^'(?:[^'\\]|\\.)*'?/)) return "string";
    if (stream.match(/^-?\d+(?:\.\d+)?/)) return "number";
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) {
      return KEYWORDS.has(stream.current()) ? "keyword" : null;
    }
    if (stream.match(/^[-+*/=!~<>:;.,()[\]{}]/)) return "operator";
    stream.next();
    return null;
  },
};

/** The drawer plugs this into the shared editor as its language. */
export const overpassLanguage = StreamLanguage.define(overpassParser);
