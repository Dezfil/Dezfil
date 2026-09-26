import { ApiError } from "@/lib/api/errors";
import {
  NOTE_COLORS,
  type LayoutDocument,
  type LayoutNote,
  type LayoutPosition,
  type NoteColor,
} from "@/lib/metadata/recipe-layouts";

/**
 * The layout document's shape.
 *
 * A write is accepted whole or refused whole, with the **first** fault
 * named: a canvas autosaving on every drag and an agent laying out a
 * workflow in one call both need the same answer, and neither is helped by
 * a partial store. One exception is deliberate: a position for a node the
 * recipe does not have is **dropped, not refused** — a canvas that lags a
 * removal by a moment must still save, and an agent that names a node it
 * has just removed should not be told its whole arrangement is wrong.
 *
 * Nothing here interprets a note's text. The `label:` line is the
 * canvas's convention; the API stores what it was given.
 */

export const NOTE_TEXT_MAX = 4_000;
export const NOTES_MAX = 100;
export const POSITIONS_MAX = 1_000;
export const POSITION_KEY_MAX = 1_000;

const refuse = (message: string): never => {
  throw new ApiError("invalid_request", message, 400);
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function finite(value: unknown, at: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    refuse(`${at} must be a finite number.`);
  }
  return value as number;
}

function position(value: unknown, at: string): LayoutPosition {
  if (!isObject(value)) refuse(`${at} must be an object with x and y.`);
  const v = value as Record<string, unknown>;
  return { x: finite(v.x, `${at}.x`), y: finite(v.y, `${at}.y`) };
}

function positions(value: unknown, at: string): Record<string, LayoutPosition> {
  if (value === undefined) return {};
  if (!isObject(value)) refuse(`${at} must be an object of positions keyed by ${at === "steps" ? "step id" : "table name"}.`);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > POSITIONS_MAX) {
    refuse(`${at} holds ${entries.length}; a document holds at most ${POSITIONS_MAX}.`);
  }
  const out: Record<string, LayoutPosition> = {};
  for (const [key, v] of entries) {
    const keyLength = [...key].length;
    if (keyLength > POSITION_KEY_MAX) {
      refuse(
        `${at} has a key of ${keyLength} characters; a key holds at most ${POSITION_KEY_MAX}.`,
      );
    }
    if (key.trim() === "") refuse(`${at} has a blank key.`);
    out[key] = position(v, `${at}.${key}`);
  }
  return out;
}

function note(value: unknown, at: string): LayoutNote {
  if (!isObject(value)) refuse(`${at} must be an object.`);
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || v.id.trim() === "") refuse(`${at}.id must be a non-blank string.`);
  const w = finite(v.w, `${at}.w`);
  const h = finite(v.h, `${at}.h`);
  if (w <= 0) refuse(`${at}.w must be positive.`);
  if (h <= 0) refuse(`${at}.h must be positive.`);
  if (typeof v.color !== "string" || !(NOTE_COLORS as readonly string[]).includes(v.color)) {
    refuse(`${at}.color must be one of ${NOTE_COLORS.join(", ")}.`);
  }
  if (typeof v.text !== "string") refuse(`${at}.text must be a string.`);
  const text = v.text as string;
  if (text.length > NOTE_TEXT_MAX) {
    refuse(`${at}.text is ${text.length} characters; a note holds at most ${NOTE_TEXT_MAX}.`);
  }
  return {
    id: v.id as string,
    x: finite(v.x, `${at}.x`),
    y: finite(v.y, `${at}.y`),
    w,
    h,
    color: v.color as NoteColor,
    text,
  };
}

function notes(value: unknown): LayoutNote[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) refuse("notes must be an array.");
  const list = value as unknown[];
  if (list.length > NOTES_MAX) {
    refuse(`notes holds ${list.length}; a document holds at most ${NOTES_MAX}.`);
  }
  const seen = new Map<string, number>();
  return list.map((v, i) => {
    const n = note(v, `notes[${i}]`);
    const first = seen.get(n.id);
    if (first !== undefined) refuse(`notes[${i}].id duplicates notes[${first}].id ("${n.id}").`);
    seen.set(n.id, i);
    return n;
  });
}

/** Keep only positions for nodes the recipe has (behaviours 2, 4, 6). */
export function pruneLayout(
  document: LayoutDocument,
  stepIds: ReadonlySet<string>,
): LayoutDocument {
  return {
    steps: Object.fromEntries(
      Object.entries(document.steps).filter(([id]) => stepIds.has(id)),
    ),
    sources: document.sources,
    notes: document.notes,
  };
}

/**
 * A request body as a document, or a refusal naming the first fault. An
 * absent map or list is the empty one — `{}` is the empty document, and a
 * write of it clears the arrangement, which is what replacing whole means.
 */
export function normalizeLayout(
  body: unknown,
  stepIds: ReadonlySet<string>,
): LayoutDocument {
  if (!isObject(body)) refuse("The layout must be a JSON object with steps, sources and notes.");
  const b = body as Record<string, unknown>;
  const document: LayoutDocument = {
    steps: positions(b.steps, "steps"),
    sources: positions(b.sources, "sources"),
    notes: notes(b.notes),
  };
  return pruneLayout(document, stepIds);
}
