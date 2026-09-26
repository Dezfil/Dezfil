"use client";

import { useCallback, useEffect, useRef } from "react";
import { EditorView, keymap, lineNumbers, placeholder } from "@codemirror/view";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  toggleComment,
} from "@codemirror/commands";
import {
  HighlightStyle,
  bracketMatching,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import {
  insertAtCursorSpec,
  replaceAllSelectingSpec,
  replaceAllSpec,
  type SqlEditorHandle,
} from "./sql-editor-handle";
import { startCompletion } from "@codemirror/autocomplete";
import {
  errorMarkExtensions,
  setErrorMark,
  sqlLanguage,
  type SqlCompletion,
  type SqlPosition,
} from "./sql-editor-extensions";
import styles from "./SqlEditor.module.css";

/* Syntax colors ride the --code-* theme tokens, so one style serves both
   the harbor-day and night-chart-room palettes. */
const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--code-keyword)", fontWeight: "600" },
  { tag: tags.typeName, color: "var(--code-keyword)" },
  {
    tag: [tags.string, tags.special(tags.string)],
    color: "var(--code-string)",
  },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--code-number)" },
  {
    tag: [tags.comment, tags.lineComment],
    color: "var(--code-comment)",
    fontStyle: "italic",
  },
  { tag: [tags.operator, tags.punctuation], color: "var(--code-operator)" },
  { tag: tags.function(tags.variableName), color: "var(--code-function)" },
]);

/* Chrome only — everything tokenized inherits the app's mono type scale. */
const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "12px",
    backgroundColor: "transparent",
    color: "var(--fg)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.75",
  },
  ".cm-content": { caretColor: "var(--fg)", padding: "0" },
  ".cm-line": { padding: "0 2px 0 4px" },
  ".cm-cursor": { borderLeftColor: "var(--fg)" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--fg-faint)",
    border: "none",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "26px",
    padding: "0 10px 0 4px",
  },
  "&.cm-focused .cm-matchingBracket": {
    backgroundColor: "color-mix(in srgb, var(--accent) 18%, transparent)",
    outline: "1px solid color-mix(in srgb, var(--accent) 45%, transparent)",
  },
  ".cm-placeholder": { color: "var(--fg-faint)" },
  // The error mark: the token underlined, its line washed, its number
  // in the gutter inked — cleared by the next keystroke.
  ".cm-sqlError": {
    textDecoration: "underline wavy var(--danger)",
    textUnderlineOffset: "3px",
  },
  ".cm-sqlErrorLine": {
    backgroundColor: "color-mix(in srgb, var(--danger) 7%, transparent)",
  },
  ".cm-sqlErrorGutter": { color: "var(--danger)", fontWeight: "600" },
  // Completion in the app's own chrome.
  ".cm-tooltip.cm-tooltip-autocomplete": {
    backgroundColor: "var(--bg-panel)",
    border: "1px solid var(--border-strong)",
    borderRadius: "10px",
    boxShadow: "0 10px 30px var(--shadow)",
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

interface Props {
  value: string;
  editable: boolean;
  /** Placeholder shown while the doc is empty (no layer selected). */
  hint: string;
  /** Accessible name of the editor; surfaces differ. */
  ariaLabel?: string;
  onChange: (sqlText: string) => void;
  /** Run with the editor's current text — never a stale draft. With
   * `runSelection` on and a non-empty selection, the selection alone,
   * flagged in the second argument. */
  onRun: (
    sqlText: string,
    meta?: { selection: boolean; from: number },
  ) => void;
  /** Borrowed imperative surface: a ref object rather than a
   * forwarded ref, so lazily loaded hosts get it without the
   * next/dynamic ref-forwarding pitfall. Null while unmounted. */
  handleRef?: React.MutableRefObject<SqlEditorHandle | null>;
  /** Language override — the OSM drawer speaks Overpass QL.
   * Fixed for the mount; hosts that need another language remount. */
  language?: Extension;
  /** Fires once the view (and the borrowed handle) exist — a host that
   * acted before the lazy chunk arrived can settle its debt (the click
   * contract's focus must survive the gap). */
  onReady?: () => void;
  /** Wrap long lines instead of scrolling sideways — opt-in per
   * host; only the add-layer workbench sets it. Fixed for the mount. */
  wrap?: boolean;
  /** Schema-driven completion — opt-in; the SQL workspace passes
   * what it knows and the editor reconfigures in place as it grows. Null
   * or absent leaves the editor without completion, as before. Ignored
   * when `language` overrides the grammar. */
  completion?: SqlCompletion | null;
  /** Mod-Enter runs a non-empty selection alone — opt-in. */
  runSelection?: boolean;
  /** Mark a reported error position; null clears. Any edit clears
   * it too. */
  errorAt?: SqlPosition | null;
  /** The selection, live — the empty string when collapsed — so a
   * host's Run button can say "Run selection" while one exists. Opt-in. */
  onSelectionChange?: (selected: string) => void;
}

/**
 * The one SQL editor (polish; shared by the workspace, by the add-layer
 * workbench): CodeMirror with the SQL grammar (DuckDB reads closest to
 * the Postgres dialect), highlighting, bracket matching, history, and
 * Mod-Enter to run — where "run" is the host's: the workspace executes,
 * the workbench previews.
 */
export default function SqlEditor({
  value,
  editable,
  hint,
  ariaLabel = "Layer SQL query",
  onChange,
  onRun,
  handleRef,
  language,
  onReady,
  wrap = false,
  completion = null,
  runSelection = false,
  errorAt = null,
  onSelectionChange,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // Compartments survive full state resets, so editable and hint swap in
  // place without rebuilding the extension list.
  const compartments = useRef({
    editable: new Compartment(),
    hint: new Compartment(),
    language: new Compartment(),
  });
  const latest = useRef({
    value,
    editable,
    hint,
    ariaLabel,
    onChange,
    onRun,
    handleRef,
    language,
    onReady,
    wrap,
    completion,
    runSelection,
    onSelectionChange,
  });
  useEffect(() => {
    latest.current = {
      value,
      editable,
      hint,
      ariaLabel,
      onChange,
      onRun,
      handleRef,
      language,
      onReady,
      wrap,
      completion,
      runSelection,
      onSelectionChange,
    };
  }, [
    value,
    editable,
    hint,
    ariaLabel,
    onChange,
    onRun,
    handleRef,
    language,
    onReady,
    wrap,
    completion,
    runSelection,
    onSelectionChange,
  ]);

  const makeState = useCallback(
    (doc: string, editableNow: boolean, hintNow: string) => {
      const c = compartments.current;
      return EditorState.create({
        doc,
        extensions: [
          lineNumbers(),
          history(),
          bracketMatching(),
          c.language.of(
            latest.current.language ?? sqlLanguage(latest.current.completion),
          ),
          errorMarkExtensions(),
          syntaxHighlighting(highlight),
          editorTheme,
          EditorView.contentAttributes.of({
            "aria-label": latest.current.ariaLabel,
          }),
          c.hint.of(placeholder(hintNow)),
          c.editable.of([
            EditorView.editable.of(editableNow),
            EditorState.readOnly.of(!editableNow),
          ]),
          Prec.high(
            keymap.of([
              {
                key: "Mod-Enter",
                run: (v) => {
                  const sel = v.state.selection.main;
                  const selected = latest.current.runSelection && !sel.empty;
                  latest.current.onRun(
                    selected
                      ? v.state.sliceDoc(sel.from, sel.to)
                      : v.state.doc.toString(),
                    { selection: selected, from: selected ? sel.from : 0 },
                  );
                  return true;
                },
              },
              { key: "Mod-/", run: toggleComment },
              // Explicit completion: Ctrl-Space is CodeMirror's own;
              // Mod-Space joins it where the OS leaves it free.
              { key: "Mod-Space", run: startCompletion },
            ]),
          ),
          ...(latest.current.wrap ? [EditorView.lineWrapping] : []),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              latest.current.onChange(u.state.doc.toString());
            }
            if (
              (u.selectionSet || u.docChanged) &&
              latest.current.onSelectionChange
            ) {
              const sel = u.state.selection.main;
              latest.current.onSelectionChange(
                sel.empty ? "" : u.state.sliceDoc(sel.from, sel.to),
              );
            }
          }),
        ],
      });
    },
    [],
  );

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: makeState(
        latest.current.value,
        latest.current.editable,
        latest.current.hint,
      ),
    });
    view.current = v;
    // The borrowed handle: the write goes through the view so the change
    // round-trips onChange like a keystroke would.
    const handle = latest.current.handleRef;
    if (handle) {
      handle.current = {
        replaceAll: (text) => {
          v.dispatch(replaceAllSpec(v.state, text));
          v.focus();
        },
        insertAtCursor: (text) => {
          v.dispatch(insertAtCursorSpec(v.state, text));
          v.focus();
        },
        getSelection: () => {
          const sel = v.state.selection.main;
          return sel.empty ? "" : v.state.sliceDoc(sel.from, sel.to);
        },
        getSelectionRange: () => {
          const sel = v.state.selection.main;
          return sel.empty ? null : { from: sel.from, to: sel.to };
        },
        replaceAllSelecting: (text, from, to) => {
          v.dispatch(replaceAllSelectingSpec(v.state, text, from, to));
          v.focus();
        },
      };
    }
    // Ready is announced after this commit's effects have run: the
    // controlled-value effect below runs after this one, and a doc that a
    // ready handler changed synchronously here would read as out of sync
    // and be reset — which is how a host's queued replacement lost its
    // undo history (the Data Explorer door on a cold navigation).
    queueMicrotask(() => {
      if (view.current === v) latest.current.onReady?.();
    });
    return () => {
      if (handle) handle.current = null;
      v.destroy();
      view.current = null;
    };
  }, [makeState]);

  // An outside rewrite — layer switch, assistant edit — replaces the doc
  // and starts a fresh undo history (Mod-Z must not resurrect another
  // layer's SQL). The user's own keystrokes round-trip through onChange
  // and match the doc, so they never land here.
  useEffect(() => {
    const v = view.current;
    if (!v || v.state.doc.toString() === value) return;
    v.setState(makeState(value, latest.current.editable, latest.current.hint));
    // A state replacement bypasses the update listener: the selection it
    // carried is gone, so say so (live selection signal).
    latest.current.onSelectionChange?.("");
  }, [value, makeState]);

  useEffect(() => {
    view.current?.dispatch({
      effects: [
        compartments.current.editable.reconfigure([
          EditorView.editable.of(editable),
          EditorState.readOnly.of(!editable),
        ]),
        compartments.current.hint.reconfigure(placeholder(hint)),
      ],
    });
  }, [editable, hint]);

  // Completion grows as the host learns the schema: swap the language
  // in place — never a state reset, which would drop the undo history
  // mid-typing. A grammar override keeps its own language.
  useEffect(() => {
    if (language) return;
    view.current?.dispatch({
      effects: compartments.current.language.reconfigure(
        sqlLanguage(completion),
      ),
    });
  }, [completion, language]);

  // The error mark follows the prop; the field clears itself on any edit.
  useEffect(() => {
    view.current?.dispatch({ effects: setErrorMark.of(errorAt ?? null) });
  }, [errorAt]);

  return <div ref={host} className={styles.cm} />;
}
