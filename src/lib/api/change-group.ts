/**
 * Consecutive edits carrying the same marker form one history step. An edit
 * outside the group starts a new step, so a turn can span several steps.
 * Grouping never crosses actors. Any client may send the documented header;
 * the in-product assistant stamps each turn automatically.
 */

export const CHANGE_GROUP_HEADER = "X-Change-Group";

const VALID_GROUP = /^[\w-]{1,64}$/;

/** The request's group marker, or null when absent or malformed —
 * a bad marker degrades to ungrouped steps, never to an error. */
export function changeGroupOf(request: Request): string | null {
  const value = request.headers.get(CHANGE_GROUP_HEADER);
  return value && VALID_GROUP.test(value) ? value : null;
}
