/**
 * Per-browser memory for the SQL workspace: the draft, the history, the
 * pane width and the editor height. Presentation state, not a workspace
 * resource — it lives in the browser's own storage, guarded so a private
 * window or a blocked store leaves the page working with nothing
 * remembered.
 */
export const SQL_KEYS = {
  /** The draft and the automatic seed it came from (when it did), so a
   * restored draft keeps its ownership — an untouched seed stays
   * replaceable across a reload, and the Data Explorer door is idempotent. */
  draft: "dezfil:sql:draft",
  history: "dezfil:sql:history",
  paneWidth: "dezfil:sql:pane-width",
  editorHeight: "dezfil:sql:editor-height",
} as const;

export function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw === null || raw === undefined ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeStored(key: string, value: unknown): void {
  try {
    if (value === null || value === undefined) {
      globalThis.localStorage?.removeItem(key);
    } else {
      globalThis.localStorage?.setItem(key, JSON.stringify(value));
    }
  } catch {
    // Storage unavailable or full: the page simply remembers nothing.
  }
}
