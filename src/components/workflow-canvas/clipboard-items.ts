import { NOTE_COLOR_NAMES } from "./note-geometry";
import { NOTE_TEXT_MAX } from "./note-text";

/**
 * The clipboard item: what a copied node or note is as text, and the
 * strict reading back. An internal, versioned interchange, not a route
 * or a tool: a node carries its operation and the values the panel
 * showed; a note its text, colour and size; nothing else travels (no
 * output, attempt, history, lineage, layout or origin). Anything that is
 * not exactly this reads as nothing, so foreign text on the clipboard
 * never becomes a paste.
 */

/** A note colour, as the layout document names it (the six tokens). */
export type NoteColor = (typeof NOTE_COLOR_NAMES)[number];

export const CLIPBOARD_MARK = "dezfil-canvas-item";
export const CLIPBOARD_VERSION = 1;

export type NodeClipboardItem = { kind: "node"; operation: string; parameters: Record<string, unknown> };
export type NoteClipboardItem = { kind: "note"; text: string; color: NoteColor; w: number; h: number };
export type ClipboardItem = NodeClipboardItem | NoteClipboardItem;

/** The text a copy writes. */
export function writeClipboardItem(item: ClipboardItem): string {
  return JSON.stringify({ [CLIPBOARD_MARK]: CLIPBOARD_VERSION, ...item });
}

/** A plain JSON value: what a parameter may hold on the wire. */
function plain(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null) return true;
  const t = typeof value;
  if (t === "string" || t === "boolean") return true;
  if (t === "number") return Number.isFinite(value as number);
  if (Array.isArray(value)) return value.every((v) => plain(v, depth + 1));
  if (t === "object") return Object.values(value as Record<string, unknown>).every((v) => plain(v, depth + 1));
  return false;
}

/** The item the text holds, or null for anything that is not one. */
export function readClipboardItem(text: string): ClipboardItem | null {
  if (typeof text !== "string" || text.length > 64_000) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  if (o[CLIPBOARD_MARK] !== CLIPBOARD_VERSION) return null;
  if (o.kind === "node") {
    if (typeof o.operation !== "string" || o.operation.trim() === "") return null;
    const p = o.parameters;
    if (!p || typeof p !== "object" || Array.isArray(p) || !plain(p)) return null;
    return { kind: "node", operation: o.operation, parameters: { ...(p as Record<string, unknown>) } };
  }
  if (o.kind === "note") {
    if (typeof o.text !== "string" || o.text.length > NOTE_TEXT_MAX) return null;
    if (typeof o.color !== "string" || !NOTE_COLOR_NAMES.includes(o.color as NoteColor)) return null;
    if (typeof o.w !== "number" || typeof o.h !== "number" || !Number.isFinite(o.w) || !Number.isFinite(o.h) || o.w <= 0 || o.h <= 0) return null;
    return { kind: "note", text: o.text, color: o.color as NoteColor, w: o.w, h: o.h };
  }
  return null;
}
