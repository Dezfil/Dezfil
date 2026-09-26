import { readApiFailure } from "../../api";
import type { PaneFailure } from "./assistant-words";

/**
 * The pane's transport helpers, shared by the turn hook and the recovery
 * hook: a documented API failure keeps its code from the response to the
 * pane's boundary, the pane's own notes carry the `pane` code, and an
 * unexpected throw is `internal`.
 */

/** An API failure with its documented code kept. */
export class RequestError extends Error { constructor(readonly code: string, message: string, readonly status: number) { super(message); } }

export async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) { const failure = await readApiFailure(response); throw new RequestError(failure.code, failure.message, response.status); }
  return response.json() as Promise<T>;
}

/** The pane's own note, or a thrown failure with its code preserved. */
export const note = (message: string): PaneFailure => ({ code: "pane", message });
export const failed = (e: unknown, fallback: string): PaneFailure =>
  e instanceof RequestError ? { code: e.code, message: e.message } : e instanceof Error ? { code: "internal", message: e.message } : note(fallback);

export const runPath = (id: string) => `/api/assistant/runs/${encodeURIComponent(id)}`;
