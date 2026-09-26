"use client";

import { useEffect, useRef, useState } from "react";
import { NodeResizer, type NodeProps } from "@xyflow/react";
import { renderNoteBody } from "@/lib/note-markdown";
import { useNoteActions } from "./note-actions";
import { NOTE_MIN } from "./note-geometry";
import { NOTE_TEXT_MAX, noteOpeningText, notePlaceholder, readNoteText } from "./note-text";
import type { NoteFlowNode } from "./to-flow";
import styles from "./NoteNode.module.css";

/**
 * A note on the canvas: a tinted box behind the graph with its label
 * strip and its markdown body; selected and not being edited, its eight
 * resize handles; editing, its raw text in a field in its own box; an
 * empty note shows its label strip and nothing else (the display-mode
 * hint was cut at a field round). The menu is
 * the canvas's overlay, and the keys are routed at the canvas, since the
 * library's wrapper holds the focus. The coordinator owns the notes and
 * their writes; this node only says what happened.
 */

const MARKDOWN = { headings: true, code: true, inertImages: true } as const;
/** What an empty note's editor shows: the
 * subset's shape, grey, never seeded into the text. */
const PLACEHOLDER = "## Heading\nYour text here, with *italic* or **bold** words.\n- a list item";

export function NoteNode({ id, data, selected, dragging }: NodeProps<NoteFlowNode>) {
  const { note, editing, locked } = data;
  const actions = useNoteActions();
  const { label, body } = readNoteText(note.text);
  return (
    <div
      className={styles.note}
      data-note
      data-note-id={note.id}
      data-color={note.color}
      data-sel={selected || undefined}
      data-editing={editing || undefined}
      data-drag={dragging || undefined}
      onDoubleClick={(e) => {
        if (editing) return;
        e.stopPropagation();
        actions.edit(note.id);
      }}
    >
      <NodeResizer
        nodeId={id}
        isVisible={selected && !editing && !locked}
        minWidth={NOTE_MIN.w}
        minHeight={NOTE_MIN.h}
        handleClassName={styles.handle}
        lineClassName={styles.line}
        onResizeEnd={(_e, p) => actions.resized(note.id, { x: p.x, y: p.y, w: p.width, h: p.height })}
      />
      {label ? (
        <span className={styles.label} data-note-label>
          {label}
        </span>
      ) : null}
      {editing ? (
        <NoteEditor id={note.id} text={note.text} onCommit={(text, closedBy) => actions.commit(note.id, text, closedBy)} />
      ) : body.trim() ? (
        <div className={styles.body} data-note-body>
          {renderNoteBody(body, MARKDOWN)}
        </div>
      ) : null}
    </div>
  );
}

/** The raw text in a field in the note's own box: focus and the caret at
 * the end on open; Escape and Ctrl/Cmd+Enter close it; the canvas's keys
 * and the node's drag never see the field's. */
function NoteEditor({ id, text, onCommit }: { id: string; text: string; onCommit: (text: string, closedBy: "key" | "blur") => void }) {
  const [draft, setDraft] = useState(() => noteOpeningText(text));
  const ref = useRef<HTMLTextAreaElement>(null);
  const committed = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const commit = (closedBy: "key" | "blur") => {
    if (committed.current) return;
    committed.current = true;
    onCommit(draft, closedBy);
  };
  const atLimit = draft.length >= NOTE_TEXT_MAX;
  // Shown only while the raw body is empty (found at review: a leading
  // space or line break is a first character too), on the caret's line.
  const placeholder = notePlaceholder(draft);
  return (
    <div className={styles.editWrap}>
      <textarea
        ref={ref}
        className={`${styles.edit} nodrag nopan nowheel`}
        aria-label="Note text"
        data-note-field={id}
        value={draft}
        maxLength={NOTE_TEXT_MAX}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit("blur")}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
            e.preventDefault();
            commit("key");
          }
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      />
      {placeholder ? (
        <pre className={styles.placeholder} aria-hidden="true" data-note-placeholder>
          {placeholder.lead + PLACEHOLDER}
        </pre>
      ) : null}
      {atLimit ? (
        <span className={styles.limit} role="status" data-note-limit>
          At the limit of 4,000 characters
        </span>
      ) : null}
    </div>
  );
}
