/**
 * The change-group marker: mutations carrying the same value land as one
 * step on the map's timeline and undo/redo together. It is a documented
 * request header, not assistant plumbing — any agent can group its own
 * edits; the in-product assistant stamps each turn automatically.
 */

export const CHANGE_GROUP_HEADER = "X-Change-Group";

const VALID_GROUP = /^[\w-]{1,64}$/;

/** The request's group marker, or null when absent or malformed —
 * a bad marker degrades to ungrouped steps, never to an error. */
export function changeGroupOf(request: Request): string | null {
  const value = request.headers.get(CHANGE_GROUP_HEADER);
  return value && VALID_GROUP.test(value) ? value : null;
}
